using System.Collections.Concurrent;
using PlayHub.Models;

namespace PlayHub.Services;

/// <summary>
/// Лобби со списком комнат (Singleton). Держит всех подключённых
/// пользователей и все активные комнаты. Деньги — WalletService.
/// </summary>
public class LobbyService
{
    private const int WinPrize = 100;

    /// <summary>Публичный размер награды за победу (для рассылок хаба).</summary>
    public static int WinPrizeAmount => WinPrize;

    /// <summary>Пароль модератора.</summary>
    public const string ModeratorPassword = "admin123";

    private static readonly int[][] Lines =
    {
        new[] { 0, 1, 2 }, new[] { 3, 4, 5 }, new[] { 6, 7, 8 },
        new[] { 0, 3, 6 }, new[] { 1, 4, 7 }, new[] { 2, 5, 8 },
        new[] { 0, 4, 8 }, new[] { 2, 4, 6 }
    };

    private readonly object _lock = new();
    private readonly LeaderboardService _leaderboard;
    private readonly WalletService _wallets;
    private readonly MinesweeperService _mines;
    private readonly ILogger<LobbyService>? _logger;

    /// <summary>Все онлайн: ConnectionId -> Player.</summary>
    public ConcurrentDictionary<string, Player> Players { get; } = new();

    /// <summary>Комнаты: RoomId -> Room.</summary>
    public ConcurrentDictionary<string, Room> Rooms { get; } = new();

    /// <summary>Событие: комната удалена (идёт вещание из хаба).</summary>
    public event Action<Room, string>? RoomRemoved;

    public LobbyService(LeaderboardService leaderboard, WalletService wallets, MinesweeperService mines, ILogger<LobbyService>? logger = null)
    {
        _leaderboard = leaderboard;
        _wallets = wallets;
        _mines = mines;
        _logger = logger;

        // раз в минуту удаляем комнаты, где никого нет / нет активности 5 минут
        _cleanupTimer = new Timer(_ => CleanupInactiveRooms(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    private readonly Timer _cleanupTimer;
    private static readonly TimeSpan RoomIdleLimit = TimeSpan.FromMinutes(5);

    /// <summary>Сколько времени комната без активности (ход, ставка, вход участника).</summary>
    private static TimeSpan RoomIdle(Room room, IReadOnlyCollection<Player> players)
    {
        var hasMembers = players.Any(p => p.CurrentRoomId == room.Id);
        if (!hasMembers) return DateTime.UtcNow - room.LastActiveAt;
        return TimeSpan.Zero; // в комнате есть люди — комната активна
    }

    /// <summary>Удалить комнаты без активности старше 5 минут.</summary>
    private void CleanupInactiveRooms()
    {
        try
        {
            var players = Players.Values.ToList();
            foreach (var room in Rooms.Values.ToList())
            {
                if (RoomIdle(room, players) >= RoomIdleLimit)
                {
                    var removed = RemoveRoom(room.Id, "Комната закрыта: неактивна более 5 минут");
                    if (removed != null) _logger?.LogInformation("Комната {RoomId} «{RoomName}» удалена: неактивна", room.Id, room.Name);
                }
            }
        }
        catch (Exception ex)
        {
            _logger?.LogError(ex, "Ошибка очистки неактивных комнат");
        }
    }

    // ---------------------------------------------------------------- вход

    public Player? AddPlayer(string connectionId, string name, bool isModerator, string avatar)
    {
        name = LeaderboardService.CleanName(name);

        var player = new Player
        {
            ConnectionId = connectionId,
            Name = name,
            Side = "",
            IsModerator = isModerator,
            Avatar = avatar
        };
        Players[connectionId] = player;
        _wallets.GetBalance(name); // создаём кошелёк новичку
        return player;
    }

    public Player? GetPlayer(string connectionId) =>
        Players.TryGetValue(connectionId, out var p) ? p : null;

    /// <summary>
    /// Перезаход игрока (новая вкладка/возврат со страницы правил) получает новый
    /// connectionId. Если под этим именем был хост комнаты — перепривязываем хост
    /// к новому соединению, чтобы имя не превращалось в «Гость» и права сохранились.
    /// </summary>
    public void RebindHosts(string connectionId, string playerName)
    {
        foreach (var room in Rooms.Values)
        {
            if (room.HostConnectionId == connectionId) continue;
            if (!string.Equals(room.HostName, playerName, StringComparison.OrdinalIgnoreCase)) continue;
            if (Players.ContainsKey(room.HostConnectionId)) continue; // старый хост ещё онлайн
            lock (room.Sync) room.HostConnectionId = connectionId;
        }
    }

    public string GetName(string connectionId) =>
        Players.TryGetValue(connectionId, out var p) ? p.Name : "Гость";

    /// <summary>Отключение: чистим игрока из комнаты.</summary>
    public void RemovePlayer(string connectionId)
    {
        if (!Players.TryRemove(connectionId, out var player)) return;

        var room = GetRoomOf(player);
        if (room == null) return;

        lock (room.Sync)
        {
            if (room.GameType == "minesweeper")
            {
                _mines.LeaveGame(room, connectionId);
                room.Bets.RemoveAll(b => b.ConnectionId == connectionId);
                if (!room.HasMembers(Players.Values)) room.Touch();
                return;
            }

            var wasX2 = room.Game.PlayerXId == connectionId;
            var wasO2 = room.Game.PlayerOId == connectionId;

            // игрок ушёл во время матча — ему засчитывается поражение
            if ((wasX2 || wasO2) && room.Game.IsStarted && !room.Game.IsFinished)
            {
                Forfeit(room, connectionId);
            }
            else
            {
                if (wasX2) room.Game.PlayerXId = "";
                if (wasO2) room.Game.PlayerOId = "";
                if (wasX2 || wasO2) ResetBoard(room); // уход наблюдателя не трогает матч
            }

            // снимаем ставки ушедшего
            room.Bets.RemoveAll(b => b.ConnectionId == connectionId);

            // отсчёт 5 минут неактивности начинается с ухода последнего участника
            if (!room.HasMembers(Players.Values)) room.Touch();
        }
    }

    /// <summary>
    /// Ушедший во время матча игрок проигрывает: победа сопернику,
    /// расчёт призов и ставок как при обычной победе.
    /// </summary>
    private void Forfeit(Room room, string leaverId)
    {
        var winnerId = room.Game.PlayerXId == leaverId ? room.Game.PlayerOId : room.Game.PlayerXId;
        var winnerSide = room.Game.PlayerXId == leaverId ? "O" : "X";
        var winner = Players.GetValueOrDefault(winnerId);

        room.Game.IsFinished = true;
        room.Game.Winner = winnerSide;
        room.Game.IsDraw = false;

        if (winner != null)
        {
            _leaderboard.AddResult(winner.Name, "win");
            _leaderboard.AddResult(GetName(leaverId), "loss");
            _wallets.Add(winner.Name, WinPrize);
        }

        // ставки: угадавшие получают удвоение
        foreach (var bet in room.Bets)
            if (bet.Side == winnerSide) _wallets.Add(bet.Name, bet.Amount * 2);

        room.Bets.Clear();
        room.Touch();
    }

    // --------------------------------------------------------------- комнаты

    /// <summary>Занято ли имя комнаты (сравнение без учёта регистра).</summary>
    public bool RoomNameTaken(string roomName)
    {
        var clean = CleanRoomName(roomName);
        return Rooms.Values.Any(r =>
            string.Equals(r.Name, clean, StringComparison.OrdinalIgnoreCase));
    }

    public Room CreateRoom(string connectionId, string roomName, string? password)
    {
        var player = GetPlayer(connectionId);
        LeaveRoom(connectionId);

        var room = new Room
        {
            Id = Guid.NewGuid().ToString("N")[..8],
            Name = CleanRoomName(roomName),
            HostConnectionId = connectionId,
            HostName = player?.Name ?? GetName(connectionId),
            Password = (password ?? "").Trim()
        };
        Rooms[room.Id] = room;

        if (player != null) player.CurrentRoomId = room.Id;
        return room;
    }

    /// <summary>Создать комнату сапёра с режимом и сложностью.</summary>
    public Room CreateMineRoom(string connectionId, string roomName, string? password, string mode, string difficultyKey, int ante)
    {
        var room = CreateRoom(connectionId, roomName, password);
        var difficulty = MineDifficulty.ByKey(difficultyKey) ?? MineDifficulty.Easy;

        room.GameType = "minesweeper";
        room.Mine = new MineGameState
        {
            Mode = MineMode.IsValid(mode) ? mode : MineMode.Solo,
            Difficulty = difficulty,
            Ante = Math.Max(MinesweeperService.MinAnte, ante)
        };
        room.Mine.InitField();
        return room;
    }

    /// <summary>
    /// Войти в комнату. Возвращает: "ok", "not-found", "wrong-password".
    /// Модератор игнорирует пароль комнаты.
    /// </summary>
    public string TryJoinRoom(string connectionId, string roomId, string? password, out Room? room)
    {
        room = null;
        if (!Rooms.TryGetValue(roomId, out var r)) return "not-found";

        var player = GetPlayer(connectionId);
        if (player == null) return "not-found";

        // модератор проходит в любую комнату без пароля; хост — в свою (перезаход)
        var isOwnRoom = string.Equals(r.HostName, player.Name, StringComparison.OrdinalIgnoreCase);
        if (r.Password != "" && !player.IsModerator && !isOwnRoom && (password ?? "") != r.Password)
            return "wrong-password";

        // за доской может сидеть только один X и один O — остальным можно смотреть
        LeaveRoom(connectionId);
        player.CurrentRoomId = r.Id;
        r.Touch();
        room = r;
        return "ok";
    }

    public void LeaveRoom(string connectionId)
    {
        var player = GetPlayer(connectionId);
        if (player == null) return;

        var room = Rooms.GetValueOrDefault(player.CurrentRoomId);
        player.CurrentRoomId = "";
        player.Side = "";
        player.IsReady = false;

        if (room == null) return;

        lock (room.Sync)
        {
            if (room.GameType == "minesweeper")
            {
                _mines.LeaveGame(room, connectionId);
                room.Bets.RemoveAll(b => b.ConnectionId == connectionId);
                if (!room.HasMembers(Players.Values)) room.Touch();
                return;
            }

            var wasX = room.Game.PlayerXId == connectionId;
            var wasO = room.Game.PlayerOId == connectionId;

            // игрок ушёл во время матча — ему засчитывается поражение
            if ((wasX || wasO) && room.Game.IsStarted && !room.Game.IsFinished)
            {
                Forfeit(room, connectionId);
            }
            else
            {
                if (wasX) room.Game.PlayerXId = "";
                if (wasO) room.Game.PlayerOId = "";
                if (wasX || wasO) ResetBoard(room); // уход наблюдателя не трогает матч
            }

            room.Bets.RemoveAll(b => b.ConnectionId == connectionId);

            // отсчёт 5 минут неактивности начинается с ухода последнего участника
            if (!room.HasMembers(Players.Values)) room.Touch();
        }
    }

    public Room? GetRoomOf(Player player) =>
        player.CurrentRoomId == "" ? null : Rooms.GetValueOrDefault(player.CurrentRoomId);

    /// <summary>
    /// Удалить комнату. Возвращает удалённую комнату или null.
    /// Выбрасывает RoomRemoved(reason) для вещания из хаба.
    /// </summary>
    public Room? RemoveRoom(string roomId, string reason)
    {
        if (!Rooms.TryRemove(roomId, out var room)) return null;

        // удаляемая комната: уходящим игрокам — поражение, несыгранные деньги — возврат
        if (room.GameType == "minesweeper")
        {
            _mines.RefundRoom(room);
        }
        else if (room.Game.IsStarted && !room.Game.IsFinished)
        {
            // матч шёл — хосту, сдавшему комнату, поражение; сопернику победа
            lock (room.Sync)
            {
                var hostId = room.HostConnectionId;
                var otherId = room.Game.PlayerXId == hostId ? room.Game.PlayerOId : room.Game.PlayerXId;
                var other = Players.GetValueOrDefault(otherId);

                _leaderboard.AddResult(GetName(hostId), "loss");
                if (other != null)
                {
                    _leaderboard.AddResult(other.Name, "win");
                    _wallets.Add(other.Name, WinPrize);
                }

                // ставки: угадавшие на победителя получают ×2
                var winnerSide = room.Game.PlayerXId == otherId ? "X" : "O";
                foreach (var b in room.Bets.Where(b => b.Side == winnerSide))
                    _wallets.Add(b.Name, b.Amount * 2);
                room.Bets.Clear();

                room.Game.IsFinished = true;
            }
        }
        else
        {
            // матча не было — ставки просто возвращаем
            lock (room.Sync)
            {
                room.Bets.ForEach(b => _wallets.Add(b.Name, b.Amount));
                room.Bets.Clear();
            }
        }

        foreach (var p in Players.Values)
        {
            if (p.CurrentRoomId == roomId)
            {
                p.CurrentRoomId = "";
                p.Side = "";
                p.IsReady = false;
            }
        }

        RoomRemoved?.Invoke(room, reason);
        return room;
    }

    // ------------------------------------------------------- выбор стороны

    public string ChooseSide(string connectionId, string side)
    {
        var player = GetPlayer(connectionId);
        if (player == null) return "no-room";

        var room = Rooms.GetValueOrDefault(player.CurrentRoomId);
        if (room == null) return "no-room";
        if (room.GameType != "tictactoe") return "В комнате сапёра используйте «Сесть играть».";

        lock (room.Sync)
        {
            var changesPlayers = false;

            if (side == "X")
            {
                if (room.Game.PlayerXId != "" && room.Game.PlayerXId != connectionId) return "taken";
                if (room.Game.PlayerXId != connectionId) changesPlayers = true;
                room.Game.PlayerXId = connectionId;
            }
            else if (side == "O")
            {
                if (room.Game.PlayerOId != "" && room.Game.PlayerOId != connectionId) return "taken";
                if (room.Game.PlayerOId != connectionId) changesPlayers = true;
                room.Game.PlayerOId = connectionId;
            }
            else
            {
                if (room.Game.PlayerXId == connectionId)
                {
                    room.Game.PlayerXId = "";
                    changesPlayers = true;
                }
                if (room.Game.PlayerOId == connectionId)
                {
                    room.Game.PlayerOId = "";
                    changesPlayers = true;
                }
            }

            var newSide = side == "X" || side == "O" ? side : "";

            // если место за доской реально сменилось - партию начинаем заново;
            // повторный клик "быть наблюдателем" уже наблюдателем ничего не сбрасывает
            if (changesPlayers) ResetBoard(room);

            player.Side = newSide;
            return "ok";
        }
    }

    // -------------------------------------------------------------- игра

    public bool CanStart(Room room)
    {
        lock (room.Sync)
        {
            if (room.Game.IsStarted || room.Game.IsFinished) return false;
            if (room.Game.PlayerXId == "" || room.Game.PlayerOId == "") return false;

            var x = Players.GetValueOrDefault(room.Game.PlayerXId);
            var o = Players.GetValueOrDefault(room.Game.PlayerOId);
            return x != null && o != null && x.IsReady && o.IsReady;
        }
    }

    public void Start(Room room)
    {
        lock (room.Sync)
        {
            ResetBoard(room);
            room.Game.IsStarted = true;
            room.Game.Turn = "X";
        }
    }

    /// <summary>Ход. Возвращает результат (Ok — ход принят).</summary>
    public MoveResult MakeMove(string connectionId, int index, out int[] winLine, out string winner)
    {
        winLine = new int[0];
        winner = "";

        var player = GetPlayer(connectionId);
        var room = player == null ? null : GetRoomOf(player);
        if (room == null || player == null) return MoveResult.NotAPlayer;

        lock (room.Sync)
        {
            var game = room.Game;
            if (!game.IsStarted) return MoveResult.GameNotStarted;
            if (game.IsFinished) return MoveResult.GameFinished;
            if (player.Side != "X" && player.Side != "O") return MoveResult.NotAPlayer;
            if (index < 0 || index > 8) return MoveResult.BadIndex;
            if (game.Board[index] != "") return MoveResult.CellTaken;
            if (game.Turn != player.Side) return MoveResult.NotYourTurn;

            game.Board[index] = player.Side;
            game.MoveCount++;
            room.Touch();

            var line = FindWinLine(game.Board, player.Side);
            if (line != null)
            {
                game.IsFinished = true;
                game.Winner = player.Side;
                game.WinLine = line;
                winLine = line;
                winner = player.Side;
                Settle(room, player);
                return MoveResult.Ok;
            }

            if (game.MoveCount >= 9)
            {
                game.IsFinished = true;
                game.IsDraw = true;
                RefundBets(room);
                return MoveResult.Ok;
            }

            game.Turn = player.Side == "X" ? "O" : "X";
            return MoveResult.Ok;
        }
    }

    /// <summary>Начислить награды за победу и рассчитать ставки.</summary>
    private void Settle(Room room, Player winner)
    {
        var loserId = winner.Side == "X" ? room.Game.PlayerOId : room.Game.PlayerXId;

        _leaderboard.AddResult(winner.Name, "win");
        _leaderboard.AddResult(GetName(loserId), "loss");
        _wallets.Add(winner.Name, WinPrize);

        // ставки: угадавшие получают удвоение, неугадавшие теряют ставку (уже списана)
        foreach (var bet in room.Bets)
        {
            if (bet.Side == winner.Side)
                _wallets.Add(bet.Name, bet.Amount * 2);
        }

        room.Bets.Clear();
    }

    /// <summary>Вернуть ставки (ничья / сброс партии).</summary>
    private void RefundBets(Room room)
    {
        foreach (var bet in room.Bets)
            _wallets.Add(bet.Name, bet.Amount);
        room.Bets.Clear();
    }

    public void Restart(Room room)
    {
        lock (room.Sync)
        {
            RefundBets(room);
            ResetBoard(room);
        }
    }

    private void ResetBoard(Room room)
    {
        var game = room.Game;
        game.Board = GameState.EmptyBoard();
        game.Turn = "X";
        game.IsStarted = false;
        game.IsFinished = false;
        game.Winner = "";
        game.IsDraw = false;
        game.WinLine = new int[0];
        game.MoveCount = 0;

        foreach (var p in Players.Values)
            if (p.CurrentRoomId == room.Id) p.IsReady = false;
    }

    private static int[]? FindWinLine(string[] board, string side)
    {
        foreach (var line in Lines)
        {
            if (board[line[0]] == side && board[line[1]] == side && board[line[2]] == side)
                return line;
        }
        return null;
    }

    // -------------------------------------------------------------- ставки

    /// <summary>Сделать ставку наблюдателем на сторону X или O.</summary>
    public string PlaceBet(string connectionId, string side, int amount, out int newBalance)
    {
        newBalance = 0;
        var player = GetPlayer(connectionId);
        if (player == null) return "Сначала войдите на сайт.";

        var room = GetRoomOf(player);
        if (room == null) return "Вы не в комнате.";
        if (room.GameType != "tictactoe") return "В комнате сапёра ставки делаются на игрока.";

        if (side != "X" && side != "O") return "Ставить можно только на ✕ или ◯.";
        if (amount <= 0) return "Сумма ставки должна быть больше нуля.";

        lock (room.Sync)
        {
            if (room.Game.IsStarted || room.Game.IsFinished)
                return "Ставки принимаются только до начала матча.";

            var bet = room.Bets.FirstOrDefault(b => b.ConnectionId == connectionId);
            if (bet != null)
                return "Вы уже сделали ставку в этой партии.";

            if (!_wallets.TryWithdraw(player.Name, amount))
                return "Недостаточно денег на балансе.";

            room.Bets.Add(new Bet
            {
                ConnectionId = connectionId,
                Name = player.Name,
                Side = side,
                Amount = amount
            });
            room.Touch();
        }

        newBalance = _wallets.GetBalance(player.Name);
        return "ok";
    }

    // ---------------------------------------------------------- снимки для UI

    public LobbySnapshot GetLobbySnapshot()
    {
        lock (_lock)
        {
            var all = Players.Values.ToList();

            var rooms = Rooms.Values.Select(r =>
            {
                var members = all.Where(p => p.CurrentRoomId == r.Id).ToList();
                lock (r.Sync)
                {
                    var isMine = r.GameType == "minesweeper";
                    var mine = r.Mine;
                    return new RoomDto
                    {
                        Id = r.Id,
                        Name = r.Name,
                        HostConnectionId = r.HostConnectionId,
                        HostName = r.HostName != "" ? r.HostName : GetName(r.HostConnectionId),
                        PlayersCount = isMine
                            ? mine!.Participants.Count
                            : members.Count(p => p.Side == "X" || p.Side == "O"),
                        SpectatorsCount = isMine
                            ? members.Count - mine!.Participants.Count
                            : members.Count(p => p.Side != "X" && p.Side != "O"),
                        InGame = isMine
                            ? mine!.IsStarted && !mine.IsFinished
                            : r.Game.IsStarted && !r.Game.IsFinished,
                        HasPassword = r.Password != "",
                        PotX = isMine ? 0 : r.Bets.Where(b => b.Side == "X").Sum(b => b.Amount),
                        PotO = isMine ? 0 : r.Bets.Where(b => b.Side == "O").Sum(b => b.Amount),
                        GameType = r.GameType,
                        MineMode = mine?.Mode ?? "",
                        MineDifficulty = mine?.Difficulty.Key ?? "",
                        MineBank = isMine ? mine!.Bank + r.Bets.Sum(b => b.Amount) : 0,
                        Avatars = members.Take(4).Select(p => p.Avatar).ToList(),
                        IdleDeleteSeconds = members.Count == 0
                            ? Math.Max(1, (int)Math.Ceiling((RoomIdleLimit - (DateTime.UtcNow - r.LastActiveAt)).TotalSeconds))
                            : 0
                    };
                }
            }).ToList();

            return new LobbySnapshot
            {
                Rooms = rooms,
                Users = all.Select(ToDto).ToList(),
                Leaderboard = _leaderboard.GetTop(10)
            };
        }
    }

    /// <summary>
    /// Публичный снимок для гостей на экране входа: онлайн, аватары,
    /// витрина комнат. Отправляется всем подключениям, ещё не вошедшим в лобби.
    /// </summary>
    public LobbyPublicSnapshot GetPublicSnapshot()
    {
        lock (_lock)
        {
            var all = Players.Values.ToList();
            var full = GetLobbySnapshot();
            return new LobbyPublicSnapshot
            {
                Online = all.Count,
                Rooms = full.Rooms
                    .OrderByDescending(r => r.InGame)
                    .ThenByDescending(r => r.PlayersCount + r.SpectatorsCount)
                    .Take(3)
                    .ToList(),
                Users = all.OrderBy(p => p.JoinedAt).Take(8).Select(ToDto).ToList(),
                Leaderboard = full.Leaderboard
            };
        }
    }

    public RoomSnapshot? GetRoomSnapshot(string connectionId)
    {
        var player = GetPlayer(connectionId);
        var room = player == null ? null : GetRoomOf(player);
        if (room == null || room.GameType == "minesweeper") return null;

        lock (room.Sync)
        {
            var members = Players.Values
                .Where(p => p.CurrentRoomId == room.Id)
                .OrderBy(p => p.JoinedAt)
                .ToList();

            return new RoomSnapshot
            {
                RoomId = room.Id,
                RoomName = room.Name,
                HostConnectionId = room.HostConnectionId,
                IsHost = room.HostConnectionId == connectionId,
                HasPassword = room.Password != "",
                Board = (string[])room.Game.Board.Clone(),
                Turn = room.Game.Turn,
                IsStarted = room.Game.IsStarted,
                IsFinished = room.Game.IsFinished,
                Winner = room.Game.Winner,
                IsDraw = room.Game.IsDraw,
                WinLine = room.Game.WinLine,
                PlayerXId = room.Game.PlayerXId,
                PlayerXName = GetName(room.Game.PlayerXId),
                PlayerOId = room.Game.PlayerOId,
                PlayerOName = GetName(room.Game.PlayerOId),
                Players = members.Where(p => p.Side == "X" || p.Side == "O").Select(ToDto).ToList(),
                Spectators = members.Where(p => p.Side != "X" && p.Side != "O").Select(ToDto).ToList(),
                Bets = room.Bets.Select(b => new BetDto
                {
                    Name = b.Name,
                    Side = b.Side,
                    Amount = b.Amount
                }).ToList(),
                BettingOpen = !room.Game.IsStarted && !room.Game.IsFinished,
                WinnerPrize = WinPrize
            };
        }
    }

    /// <summary>Снимок комнаты сапёра для клиента.</summary>
    public MineSnapshot? GetMineSnapshot(string connectionId)
    {
        var player = GetPlayer(connectionId);
        var room = player == null ? null : GetRoomOf(player);
        if (room == null || room.GameType != "minesweeper") return null;
        return _mines.GetSnapshot(room, connectionId, GetName, Players.Values.ToList());
    }

    /// <summary>Тик таймеров сапёра: возвращает комнаты, где состояние изменилось.</summary>
    public List<Room> TickMines()
    {
        var changed = new List<Room>();
        foreach (var room in Rooms.Values)
        {
            if (room.GameType != "minesweeper") continue;

            // истёк резерв места хоста в одиночке — уведомляем комнату
            if (room.Mine is { IsStarted: false, HostSeatReservedUntil: { } deadline } &&
                DateTime.UtcNow >= deadline)
            {
                lock (room.Sync) room.Mine.HostSeatReservedUntil = null;
                changed.Add(room);
                continue;
            }

            if (_mines.Tick(room))
                changed.Add(room);
        }
        return changed;
    }

    private static PlayerDto ToDto(Player p) => new()
    {
        ConnectionId = p.ConnectionId,
        Name = p.Name,
        Side = p.Side,
        IsReady = p.IsReady,
        IsModerator = p.IsModerator,
        Avatar = p.Avatar
    };

    private static string CleanRoomName(string? name)
    {
        name = (name ?? "").Trim();
        if (name.Length > 24) name = name[..24];
        return string.IsNullOrEmpty(name) ? "Комната" : name;
    }
}
