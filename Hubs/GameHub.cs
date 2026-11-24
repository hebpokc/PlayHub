using Microsoft.AspNetCore.SignalR;
using PlayHub.Models;
using PlayHub.Services;

namespace PlayHub.Hubs;

/// <summary>
/// Хаб SignalR. Вход → лобби (список комнат) → комната (партия + ставки).
/// Модератор входит с паролем и может кикать/банить/удалять комнаты.
/// </summary>
public class GameHub : Hub
{
    private readonly LobbyService _lobby;
    private readonly ChatService _chat;
    private readonly WalletService _wallets;
    private readonly ModerationService _moderation;
    private readonly MinesweeperService _mines;
    private readonly AvatarService _avatars;
    private readonly BonusService _bonuses;
    private readonly WinFeedService _winFeed;

    public GameHub(LobbyService lobby, ChatService chat, WalletService wallets, ModerationService moderation,
        MinesweeperService mines, AvatarService avatars, BonusService bonuses, WinFeedService winFeed)
    {
        _lobby = lobby;
        _chat = chat;
        _wallets = wallets;
        _moderation = moderation;
        _mines = mines;
        _avatars = avatars;
        _bonuses = bonuses;
        _winFeed = winFeed;
    }

    /// <summary>Шаг 1. Вход по имени. Модератор указывает доп. пароль.</summary>
    public async Task Join(string? name, string? moderatorPassword, string? avatar = null)
    {
        var playerName = LeaderboardService.CleanName(name ?? "");

        if (_moderation.IsBanned(playerName))
        {
            await Clients.Caller.SendAsync("Banned");
            return;
        }

        var isModerator = !string.IsNullOrEmpty(moderatorPassword)
            && moderatorPassword == LobbyService.ModeratorPassword;

        if (!string.IsNullOrEmpty(moderatorPassword) && !isModerator)
        {
            await Clients.Caller.SendAsync("ServerError", "Неверный пароль модератора.");
            return;
        }

        // аватар: присланный с формы входа или сохранённый ранее
        var playerAvatar = string.IsNullOrEmpty(avatar)
            ? _avatars.Get(playerName)
            : _avatars.Set(playerName, avatar);

        _lobby.AddPlayer(Context.ConnectionId, playerName, isModerator, playerAvatar);
        _lobby.RebindHosts(Context.ConnectionId, playerName);

        await Clients.Caller.SendAsync("Welcome", new
        {
            connectionId = Context.ConnectionId,
            name = playerName,
            isModerator,
            avatar = playerAvatar,
            balance = _wallets.GetBalance(playerName),
            bonus = _bonuses.GetStatus(playerName)
        });

        await Clients.Caller.SendAsync("ChatHistory", _chat.GetHistory());
        await Clients.All.SendAsync("WinFeed", _winFeed.GetLatest());
        await Clients.All.SendAsync("UserJoined", playerName);
        await SendSystemMessage(isModerator
            ? $"{playerName} зашёл на сайт как модератор 🛡"
            : $"{playerName} зашёл на сайт");
        await BroadcastLobby();
    }

    // --------------------------------------------------------------- комнаты

    /// <summary>
    /// Гостевое подключение с экрана входа: живой счётчик онлайна,
    /// аватары присутствующих и витрина комнат — до регистрации.
    /// </summary>
    public Task<LobbyPublicSnapshot> WatchLobby() => Task.FromResult(_lobby.GetPublicSnapshot());

    /// <summary>Забрать бонус +50 (раз в 15 минут).</summary>
    public async Task ClaimTimedBonus()
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        if (player == null)
        {
            await Clients.Caller.SendAsync("ServerError", "Сначала войдите на сайт.");
            return;
        }

        var amount = _bonuses.ClaimTimed(player.Name);
        if (amount == null)
        {
            await Clients.Caller.SendAsync("BonusDenied", "Бонус можно забирать раз в 15 минут.");
            return;
        }

        var balance = _wallets.Add(player.Name, amount.Value);
        await Clients.Caller.SendAsync("BonusClaimed", new
        {
            amount = amount.Value,
            balance,
            bonus = _bonuses.GetStatus(player.Name)
        });
    }

    /// <summary>Забрать ежедневный бонус +25 (раз в сутки).</summary>
    public async Task ClaimDailyBonus()
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        if (player == null)
        {
            await Clients.Caller.SendAsync("ServerError", "Сначала войдите на сайт.");
            return;
        }

        var amount = _bonuses.ClaimDaily(player.Name);
        if (amount == null)
        {
            await Clients.Caller.SendAsync("BonusDenied", "Ежедневный бонус уже забран — возвращайтесь завтра!");
            return;
        }

        var balance = _wallets.Add(player.Name, amount.Value);
        await Clients.Caller.SendAsync("BonusClaimed", new
        {
            amount = amount.Value,
            balance,
            bonus = _bonuses.GetStatus(player.Name)
        });
    }

    /// <summary>Сменить аватар (проверяется по белому списку).</summary>
    public async Task SetAvatar(string? avatar)
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        if (player == null) return;

        player.Avatar = _avatars.Set(player.Name, avatar);
        await BroadcastLobby();
    }

    public async Task CreateRoom(string? roomName, string? password)
    {
        if (_lobby.RoomNameTaken(roomName ?? ""))
        {
            await Clients.Caller.SendAsync("ServerError", "Комната с таким названием уже существует.");
            return;
        }

        var room = _lobby.CreateRoom(Context.ConnectionId, roomName ?? "", password);
        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(room.Id));
        await SendSystemMessage($"{_lobby.GetName(Context.ConnectionId)} создал комнату «{room.Name}»" +
            (room.Password != "" ? " 🔒" : ""));
        await BroadcastLobby();
        await BroadcastRoom(room.Id);
        await SendRoomToCaller();
    }

    /// <summary>Создать комнату сапёра: режим, сложность, ante.</summary>
    public async Task CreateMineRoom(string? roomName, string? password, string? mode, string? difficulty, int ante)
    {
        if (_lobby.RoomNameTaken(roomName ?? ""))
        {
            await Clients.Caller.SendAsync("ServerError", "Комната с таким названием уже существует.");
            return;
        }

        var room = _lobby.CreateMineRoom(Context.ConnectionId, roomName ?? "", password,
            mode ?? "solo", difficulty ?? "easy", ante);
        if (room.Mine!.Mode == Models.MineMode.Solo) _mines.ReserveHostSeat(room);
        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(room.Id));
        await SendSystemMessage($"{_lobby.GetName(Context.ConnectionId)} создал комнату сапёра «{room.Name}» 💣" +
            (room.Password != "" ? " 🔒" : ""));
        await BroadcastLobby();
        await BroadcastRoom(room.Id);
        await SendRoomToCaller();
    }

    public async Task JoinRoom(string? roomId, string? password)
    {
        var result = _lobby.TryJoinRoom(Context.ConnectionId, roomId ?? "", password, out var room);

        if (result == "not-found")
        {
            await Clients.Caller.SendAsync("ServerError", "Комната не найдена.");
            await BroadcastLobby();
            return;
        }
        if (result == "wrong-password")
        {
            var locked = _lobby.Rooms.GetValueOrDefault(roomId ?? "");
            await Clients.Caller.SendAsync("RoomPasswordRequired", new { roomId, roomName = locked?.Name ?? "Комната" });
            return;
        }
        if (room == null) return;

        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(room.Id));
        await SendSystemMessage($"{_lobby.GetName(Context.ConnectionId)} вошёл в комнату «{room.Name}»");
        await BroadcastLobby();
        await BroadcastRoom(room.Id);
        await SendRoomToCaller();
    }

    public async Task LeaveRoom()
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        var room = player == null ? null : _lobby.GetRoomOf(player);
        var roomName = room?.Name ?? "";

        // уход игрока X/O во время матча = поражение: зафиксируем исход для рассылки
        var forfeit = GetForfeitContext(room, Context.ConnectionId);

        _lobby.LeaveRoom(Context.ConnectionId);
        if (room != null) await Groups.RemoveFromGroupAsync(Context.ConnectionId, RoomGroup(room.Id));

        if (roomName != "")
            await SendSystemMessage($"{_lobby.GetName(Context.ConnectionId)} покинул комнату «{roomName}»");

        if (forfeit != null)
            await AnnounceForfeit(room!, forfeit.Value.Winner, forfeit.Value.WinnerName, forfeit.Value.LeaverName);

        await BroadcastLobby();
        if (room != null)
        {
            // уход сапёра мог закончить партию (форфит) — сообщим остальным
            if (room.GameType == "minesweeper") await AfterMineAction(room);
            await BroadcastRoom(room.Id);
        }
        await Clients.Caller.SendAsync("RoomLeft");
    }

    private (string Winner, string WinnerName, string LeaverName)? GetForfeitContext(Room? room, string connectionId)
    {
        if (room == null || room.GameType != "tictactoe") return null;
        lock (room.Sync)
        {
            var g = room.Game;
            if (!g.IsStarted || g.IsFinished) return null;

            var isX = g.PlayerXId == connectionId;
            var isO = g.PlayerOId == connectionId;
            if (!isX && !isO) return null;

            var winner = isX ? "O" : "X";
            var winnerId = isX ? g.PlayerOId : g.PlayerXId;
            return (winner, _lobby.GetName(winnerId), _lobby.GetName(connectionId));
        }
    }

    private async Task AnnounceForfeit(Room room, string winner, string winnerName, string leaverName)
    {
        await RoomClients(room).SendAsync("GameFinished", new
        {
            winner,
            winnerName,
            loserName = leaverName,
            isDraw = false,
            winLine = new int[0],
            prize = LobbyService.WinPrizeAmount
        });
        await SendSystemMessage($"{leaverName} покинул матч во время игры — победа за {winnerName} 🏳");
        _winFeed.Add(winnerName, LobbyService.WinPrizeAmount, "✕◯ Форфит");

        foreach (var p in _lobby.Players.Values.Where(p => p.CurrentRoomId == room.Id))
            await Clients.Client(p.ConnectionId).SendAsync("BalanceUpdated", _wallets.GetBalance(p.Name));
    }

    /// <summary>Снимок комнаты для текущего подключения.</summary>
    public Task<RoomSnapshot?> GetRoomState() => Task.FromResult(_lobby.GetRoomSnapshot(Context.ConnectionId));

    // ------------------------------------------------------------- игра

    public async Task ChooseSide(string? side)
    {
        side = side == "X" || side == "O" ? side : "";
        var result = _lobby.ChooseSide(Context.ConnectionId, side);

        if (result == "no-room")
        {
            await Clients.Caller.SendAsync("ServerError", "Сначала войдите в комнату.");
            return;
        }
        if (result == "taken")
        {
            await Clients.Caller.SendAsync("ServerError", "Это место уже занято. Выберите другое.");
            await SendRoomToCaller();
            return;
        }

        var player = _lobby.GetPlayer(Context.ConnectionId);
        if (player != null && _lobby.GetRoomOf(player) is { } r)
        {
            var role = side switch
            {
                "X" => "играет крестиками ✕",
                "O" => "играет ноликами ◯",
                _ => "теперь наблюдатель 👁"
            };
            await SendSystemMessage($"{player.Name} {role}");
            await BroadcastRoom(r.Id);
        }
    }

    public async Task SetReady(bool ready)
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        if (player == null) return;

        var room = _lobby.GetRoomOf(player);
        if (room == null || room.GameType != "tictactoe") return;

        if (player.Side == "X" || player.Side == "O") player.IsReady = ready;

        if (_lobby.CanStart(room))
        {
            _lobby.Start(room);
            await RoomClients(room).SendAsync("MatchStarted");
            await SendSystemMessage("Матч начался! Первыми ходят крестики ✕ — ставки больше не принимаются");
        }
        else if (ready)
        {
            await SendSystemMessage($"{player.Name} готов к матчу");
        }

        await BroadcastRoom(room.Id);
    }

    public async Task MakeMove(int index)
    {
        var result = _lobby.MakeMove(Context.ConnectionId, index, out var winLine, out var winner);

        if (result != MoveResult.Ok)
        {
            var message = result switch
            {
                MoveResult.NotYourTurn => "Сейчас не ваш ход.",
                MoveResult.CellTaken => "Клетка уже занята.",
                MoveResult.GameNotStarted => "Матч ещё не начался.",
                MoveResult.GameFinished => "Партия уже закончилась.",
                MoveResult.NotAPlayer => "Сначала войдите в комнату и выберите сторону.",
                _ => "Некорректный ход."
            };
            await Clients.Caller.SendAsync("ServerError", message);
            return;
        }

        var player = _lobby.GetPlayer(Context.ConnectionId);
        var room = player == null ? null : _lobby.GetRoomOf(player);
        if (room == null) return;

        await BroadcastRoom(room.Id);

        var snapshot = _lobby.GetRoomSnapshot(Context.ConnectionId);
        if (snapshot is { IsFinished: true })
        {
            var winnerName = winner == "X" ? snapshot.PlayerXName : snapshot.PlayerOName;

            await RoomClients(room).SendAsync("GameFinished", new
            {
                winner,
                winnerName,
                loserName = winner == "X" ? snapshot.PlayerOName : snapshot.PlayerXName,
                isDraw = snapshot.IsDraw,
                winLine,
                prize = snapshot.WinnerPrize
            });

            await SendSystemMessage(snapshot.IsDraw
                ? "Партия закончилась вничью 🤝 — ставки возвращены"
                : $"{winnerName} побеждает! 🎉 +{snapshot.WinnerPrize} монет");
            if (!snapshot.IsDraw) _winFeed.Add(winnerName, snapshot.WinnerPrize, "✕◯ Крестики-нолики");

            // обновляем балансы всем в комнате
            foreach (var p in _lobby.Players.Values.Where(p => p.CurrentRoomId == room.Id))
                await Clients.Client(p.ConnectionId).SendAsync("BalanceUpdated", _wallets.GetBalance(p.Name));
        }
    }

    public async Task Restart()
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        var room = player == null ? null : _lobby.GetRoomOf(player);
        if (room == null || room.GameType != "tictactoe") return;

        _lobby.Restart(room);
        await RoomClients(room).SendAsync("GameRestarted");
        await SendSystemMessage("Доска очищена — ставки снова открыты, нажмите «Готов»");
        await BroadcastRoom(room.Id);
    }

    // ------------------------------------------------------------- ставки

    public async Task PlaceBet(string? side, int amount)
    {
        var result = _lobby.PlaceBet(Context.ConnectionId, side ?? "", amount, out var newBalance);

        if (result != "ok")
        {
            await Clients.Caller.SendAsync("ServerError", result);
            return;
        }

        var player = _lobby.GetPlayer(Context.ConnectionId);
        var room = player == null ? null : _lobby.GetRoomOf(player);

        await Clients.Caller.SendAsync("BalanceUpdated", newBalance);
        if (player != null && room != null)
        {
            await SendSystemMessage($"{player.Name} поставил {amount} монет на {(side == "X" ? "✕" : "◯")}");
            await BroadcastRoom(room.Id);
        }
    }

    // ------------------------------------------------------------- сапёр

    /// <summary>Занять место игрока в сапёре.</summary>
    public async Task MineJoin()
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        var result = _mines.JoinGame(room!, player!);
        if (result != "ok") { await Clients.Caller.SendAsync("ServerError", result); return; }

        await SendSystemMessage($"{player!.Name} садится играть в сапёр 💣");
        await BroadcastRoom(room!.Id);
        await BroadcastLobby();
    }

    /// <summary>Покинуть место игрока (стать наблюдателем).</summary>
    public async Task MineLeave()
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        _mines.LeaveGame(room!, player!.ConnectionId);
        await BroadcastRoom(room!.Id);
        await BroadcastLobby();
        await RefreshBalances(room!);
    }

    /// <summary>«Готов» + внесение ante.</summary>
    public async Task MineReady(int ante)
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        var (result, started) = _mines.SetReady(room!, player!.ConnectionId, ante);
        if (result != "ok") { await Clients.Caller.SendAsync("ServerError", result); return; }

        await Clients.Caller.SendAsync("BalanceUpdated", _wallets.GetBalance(player.Name));

        if (started)
        {
            await RoomClients(room!).SendAsync("MineMatchStarted");
            var g = room!.Mine!;
            await SendSystemMessage(g.IsPlacing
                ? $"Сапёр: {_lobby.GetName(g.TurnId)} расставляет мины ({g.MineCount} шт, 60 секунд)"
                : "Сапёр: партия началась! Первый ход всегда безопасный 💣");
        }
        else
        {
            await SendSystemMessage($"{player.Name} готов к партии в сапёр");
        }

        await BroadcastRoom(room!.Id);
        await BroadcastLobby();
    }

    /// <summary>Открыть клетку (левый клик).</summary>
    public async Task MineOpen(int index)
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        var (result, points, exploded) = _mines.Open(room!, player!.ConnectionId, index);
        if (result != MineActionResult.Ok)
        {
            await Clients.Caller.SendAsync("ServerError", MineErrorText(result));
            return;
        }

        if (exploded)
            await RoomClients(room!).SendAsync("MineExploded", new { index, name = player.Name });
        else if (points > 0)
            await Clients.Caller.SendAsync("MinePoints", new { points });

        await BroadcastRoom(room!.Id);
        await AfterMineAction(room!);
    }

    /// <summary>Флажок (правый клик).</summary>
    public async Task MineFlag(int index)
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        var result = _mines.ToggleFlag(room!, player!.ConnectionId, index);
        if (result != MineActionResult.Ok)
        {
            await Clients.Caller.SendAsync("ServerError", MineErrorText(result));
            return;
        }

        await BroadcastRoom(room!.Id);
        await AfterMineAction(room!);
    }

    /// <summary>Асим: террорист ставит/снимает мину.</summary>
    public async Task MinePlace(int index)
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        var result = _mines.PlaceMine(room!, player!.ConnectionId, index);
        if (result != MineActionResult.Ok)
        {
            await Clients.Caller.SendAsync("ServerError",
                result == MineActionResult.BadIndex ? "Лимит мин исчерпан или неверная клетка." : MineErrorText(result));
            return;
        }
        await BroadcastRoom(room!.Id);
    }

    /// <summary>Асим: террорист завершил расстановку.</summary>
    public async Task MineFinishPlacing()
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        if (!_mines.FinishPlacing(room!, player!.ConnectionId))
        {
            await Clients.Caller.SendAsync("ServerError", $"Расставьте все мины ({room!.Mine!.MineCount} шт).");
            return;
        }
        await SendSystemMessage("Мины расставлены — сапёр начинает разминирование!");
        await BroadcastRoom(room!.Id);
    }

    /// <summary>Асим-риск: сапёр забирает накопленную долю банка и уходит.</summary>
    public async Task MineCashOut()
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        var (result, sapperPayout, terroristPayout) = _mines.CashOut(room!, player!.ConnectionId);
        if (result != MineActionResult.Ok)
        {
            await Clients.Caller.SendAsync("ServerError", result == MineActionResult.NotStarted
                ? "Сначала откройте хотя бы одну клетку — забирать пока нечего."
                : MineErrorText(result));
            return;
        }

        await SendSystemMessage(
            $"Сапёр: {player.Name} забрал {sapperPayout}💰 и ушёл с поля 🏃 — террористу {terroristPayout}💰 за риск");
        await BroadcastRoom(room!.Id);
        await AfterMineAction(room!);
    }

    /// <summary>Сдаться.</summary>
    public async Task MineSurrender()
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        if (!_mines.Surrender(room!, player!.ConnectionId))
        {
            await Clients.Caller.SendAsync("ServerError", "Сдаться можно только во время партии.");
            return;
        }
        await SendSystemMessage($"{player!.Name} сдался 🏳");
        await BroadcastRoom(room!.Id);
        await AfterMineAction(room!);
    }

    /// <summary>Новая партия в сапёре (только после окончания текущей).</summary>
    public async Task MineRestart()
    {
        var (_, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }
        if (!room!.Mine!.IsFinished)
        {
            await Clients.Caller.SendAsync("ServerError", "Новую партию можно начать после окончания текущей.");
            return;
        }

        _mines.Restart(room!);
        await RoomClients(room!).SendAsync("MineGameRestarted");
        await SendSystemMessage("Сапёр: новая партия — внесите ставку и нажмите «Готов»");
        await BroadcastRoom(room!.Id);
        await BroadcastLobby();
    }

    /// <summary>Ставка наблюдателя на игрока (targetId = ConnectionId).</summary>
    public async Task MineBet(string? targetId, int amount)
    {
        var (player, room, error) = RequireMineRoom();
        if (error != "") { await Clients.Caller.SendAsync("ServerError", error); return; }

        var result = _mines.PlaceBet(room!, player!, targetId ?? "", amount, out var newBalance);
        if (result != "ok") { await Clients.Caller.SendAsync("ServerError", result); return; }

        await Clients.Caller.SendAsync("BalanceUpdated", newBalance);
        await SendSystemMessage($"{player!.Name} поставил {amount} монет на {_lobby.GetName(targetId ?? "")}");
        await BroadcastRoom(room!.Id);
        await BroadcastLobby();
    }

    /// <summary>Таблица рекордов одиночного сапёра — видна всем.</summary>
    public Task<List<MineRecordDto>> GetMineRecords() => Task.FromResult(_mines.GetRecordsTop());

    private (Player? Player, Room? Room, string Error) RequireMineRoom()
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        if (player == null) return (null, null, "Сначала войдите на сайт.");
        var room = _lobby.GetRoomOf(player);
        if (room == null) return (null, null, "Сначала войдите в комнату.");
        if (room.GameType != "minesweeper") return (null, null, "Эта комната — не сапёр.");
        return (player, room, "");
    }

    private static string MineErrorText(MineActionResult r) => r switch
    {
        MineActionResult.NotParticipant => "Вы не игрок в этой партии (или уже выбыли).",
        MineActionResult.NotStarted => "Партия ещё не началась.",
        MineActionResult.Finished => "Партия уже закончилась.",
        MineActionResult.NotYourTurn => "Сейчас не ваш ход.",
        MineActionResult.BadIndex => "Неверная клетка.",
        MineActionResult.AlreadyOpened => "Клетка уже открыта.",
        MineActionResult.IsFlagged => "Сначала снимите флажок.",
        MineActionResult.PlacingPhase => "Идёт расстановка мин.",
        MineActionResult.NotPlacingPhase => "Сейчас не фаза расстановки.",
        _ => "Действие недоступно."
    };

    /// <summary>После хода: если партия закончилась — событие и обновление балансов.</summary>
    private async Task AfterMineAction(Room room)
    {
        var g = room.Mine!;
        if (!g.IsFinished) return;

        await RoomClients(room).SendAsync("MineGameFinished", new
        {
            winnerId = g.WinnerId,
            winnerName = g.WinnerName,
            isDraw = g.IsDraw,
            payout = g.WinnerPayout,
            explodedIndex = g.ExplodedIndex,
            isCashOut = g.SapperPayout > 0 || g.TerroristPayout > 0,
            sapperPayout = g.SapperPayout,
            terroristPayout = g.TerroristPayout
        });

        await SendSystemMessage(g.IsDraw
            ? "Сапёр: ничья 🤝 — ставки возвращены"
            : g.SapperPayout > 0 || g.TerroristPayout > 0
                ? $"Сапёр: банк разделён 🤝 — сапёру {g.SapperPayout}💰, террористу {g.TerroristPayout}💰; победа за {g.WinnerName}"
                : g.WinnerPayout > 0
                    ? $"Сапёр: {g.WinnerName} побеждает! 🎉 +{g.WinnerPayout} монет из банка"
                    : $"Сапёр: партия окончена, победитель — {g.WinnerName}");

        if (!g.IsDraw && !string.IsNullOrEmpty(g.WinnerName) && g.WinnerPayout > 0)
            _winFeed.Add(g.WinnerName, g.WinnerPayout, MineGameLabel(g.Mode));

        await RefreshBalances(room);
        await BroadcastLobby();
    }

    private static string MineGameLabel(string mode) => mode switch
    {
        "pvp" => "💣 Сапёр-дуэль",
        "asym" => "💣 Сапёр vs Террорист",
        "cinema" => "🎬 Кинотеатр",
        _ => "💣 Сапёр"
    };

    private async Task RefreshBalances(Room room)
    {
        foreach (var p in _lobby.Players.Values.Where(p => p.CurrentRoomId == room.Id))
            await Clients.Client(p.ConnectionId).SendAsync("BalanceUpdated", _wallets.GetBalance(p.Name));
    }

    // ------------------------------------------------------------- модерация

    public async Task KickUser(string? connectionId)
    {
        if (!RequireModerator(out var error))
        {
            await Clients.Caller.SendAsync("ServerError", error);
            return;
        }

        if (_lobby.Players.TryGetValue(connectionId ?? "", out var target))
        {
            if (target.IsModerator)
            {
                await Clients.Caller.SendAsync("ServerError", "Нельзя кикнуть другого модератора.");
                return;
            }

            var moderator = _lobby.GetPlayer(Context.ConnectionId);
            if (moderator != null) _moderation.RecordAction(moderator.Name, "kick");

            await Clients.Client(target.ConnectionId).SendAsync("Kicked", "Модератор исключил вас с сайта.");
            await SendSystemMessage($"Модератор кикнул {target.Name}");
            await Clients.Client(target.ConnectionId).SendAsync("ForceDisconnect");
        }
    }

    public async Task BanUser(string? connectionId)
    {
        if (!RequireModerator(out var error))
        {
            await Clients.Caller.SendAsync("ServerError", error);
            return;
        }

        if (_lobby.Players.TryGetValue(connectionId ?? "", out var target))
        {
            if (target.IsModerator)
            {
                await Clients.Caller.SendAsync("ServerError", "Нельзя забанить другого модератора.");
                return;
            }

            var moderator = _lobby.GetPlayer(Context.ConnectionId);
            if (_moderation.Ban(target.Name) && moderator != null)
                _moderation.RecordAction(moderator.Name, "ban");

            await Clients.Client(target.ConnectionId).SendAsync("Kicked", "Модератор забанил вас на сайте.");
            await SendSystemMessage($"Модератор забанил {target.Name}");
        }
    }

    public async Task UnbanUser(string? name)
    {
        if (!RequireModerator(out var error))
        {
            await Clients.Caller.SendAsync("ServerError", error);
            return;
        }

        var ok = _moderation.Unban(name ?? "");
        await Clients.Caller.SendAsync(ok ? "ServerError" : "ServerError",
            ok ? $"{name} разбанен." : "Такой забаненный не найден.");
        await SendSystemMessage(ok ? $"Модератор разбанил {name}" : "Разбан не удался: имя не найдено");
    }

    public Task<List<string>> GetBannedList()
    {
        if (!RequireModerator(out _)) return Task.FromResult(new List<string>());
        return Task.FromResult(_moderation.GetBannedList());
    }

    /// <summary>Таблица балансов всех пользователей — видна всем.</summary>
    public Task<List<BalanceEntryDto>> GetBalances()
    {
        return Task.FromResult(_wallets.GetAllBalances());
    }

    /// <summary>Статистика модераторов: баны + кики (работник месяца — первый в списке). Видна всем.</summary>
    public Task<List<ModeratorStatDto>> GetModeratorStats()
    {
        return Task.FromResult(_moderation.GetStats());
    }

    public async Task DeleteRoom(string? roomId)
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        if (player == null)
        {
            await Clients.Caller.SendAsync("ServerError", "Сначала войдите на сайт.");
            return;
        }

        // удалить можно свою комнату (хост) или любую — будучи модератором
        var targetId = roomId ?? "";
        if (targetId == "")
        {
            var myRoom = _lobby.GetRoomOf(player);
            if (myRoom == null)
            {
                await Clients.Caller.SendAsync("ServerError", "Вы не в комнате.");
                return;
            }
            targetId = myRoom.Id;
        }

        if (!_lobby.Rooms.TryGetValue(targetId, out var room))
        {
            await Clients.Caller.SendAsync("ServerError", "Комната не найдена.");
            return;
        }

        var isHost = room.HostConnectionId == Context.ConnectionId
            || string.Equals(room.HostName, player.Name, StringComparison.OrdinalIgnoreCase);
        if (!isHost && !player.IsModerator)
        {
            await Clients.Caller.SendAsync("ServerError", "Удалять комнату может только её хост или модератор.");
            return;
        }

        var removed = _lobby.RemoveRoom(targetId, isHost ? "Хост удалил комнату" : "Модератор удалил комнату");
        if (removed == null)
        {
            await Clients.Caller.SendAsync("ServerError", "Комната не найдена.");
            return;
        }

        // возвраты/выплаты при удалении комнаты могли задеть любого пользователя
        // (в т.ч. ставочника из другой комнаты) — обновляем всем
        foreach (var p in _lobby.Players.Values)
            await Clients.Client(p.ConnectionId).SendAsync("BalanceUpdated", _wallets.GetBalance(p.Name));
    }

    private bool RequireModerator(out string error)
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        if (player is { IsModerator: true })
        {
            error = "";
            return true;
        }
        error = "Недостаточно прав: только модератор может это делать.";
        return false;
    }

    // ------------------------------------------------------------- чат

    public async Task SendMessage(string? text)
    {
        if (!ChatService.IsValid(text)) return;

        if (!_lobby.Players.TryGetValue(Context.ConnectionId, out var player))
        {
            await Clients.Caller.SendAsync("ServerError", "Сначала войдите на сайт.");
            return;
        }

        var message = _chat.Add(player.Name, text!, player.Side, player.IsModerator);
        await Clients.All.SendAsync("ChatMessage", message);
    }

    public List<LeaderboardEntry> GetLeaderboard() => _lobby.GetLobbySnapshot().Leaderboard;

    // ------------------------------------------------------------- отключение

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        var room = player == null ? null : _lobby.GetRoomOf(player);

        // дисконнект игрока X/O во время матча = поражение: зафиксируем исход для рассылки
        var forfeit = GetForfeitContext(room, Context.ConnectionId);

        _lobby.RemovePlayer(Context.ConnectionId);

        if (player != null)
        {
            await Clients.All.SendAsync("UserLeft", player.Name);
            await SendSystemMessage($"{player.Name} покинул сайт");
        }

        if (forfeit != null)
            await AnnounceForfeit(room!, forfeit.Value.Winner, forfeit.Value.WinnerName, forfeit.Value.LeaverName);

        await BroadcastLobby();
        if (room != null)
        {
            // дисконнект сапёра мог закончить партию (форфит) — сообщим остальным
            if (room.GameType == "minesweeper") await AfterMineAction(room);
            await BroadcastRoom(room.Id);
        }
        await base.OnDisconnectedAsync(exception);
    }

    // ------------------------------------------------------------- helpers

    private string RoomGroup(string roomId) => $"room-{roomId}";

    private IClientProxy RoomClients(Room room) => Clients.Group(RoomGroup(room.Id));

    private async Task BroadcastLobby()
    {
        var snapshot = _lobby.GetLobbySnapshot();
        foreach (var p in snapshot.Users)
        {
            await Clients.Client(p.ConnectionId).SendAsync("LobbyUpdated", snapshot);
        }

        // гости на экране входа: живой онлайн, аватары и витрина комнат
        var guests = Clients.AllExcept(snapshot.Users.Select(u => u.ConnectionId).ToList());
        await guests.SendAsync("LobbyPreview", _lobby.GetPublicSnapshot());
    }

    private async Task SendRoomToCaller()
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        var room = player == null ? null : _lobby.GetRoomOf(player);
        if (room is { GameType: "minesweeper" })
            await Clients.Caller.SendAsync("MineRoomUpdated", _lobby.GetMineSnapshot(Context.ConnectionId));
        else
            await Clients.Caller.SendAsync("RoomUpdated", _lobby.GetRoomSnapshot(Context.ConnectionId));
    }

    private async Task BroadcastRoom(string roomId)
    {
        var group = RoomGroup(roomId);
        var members = _lobby.Players.Values.Where(p => p.CurrentRoomId == roomId).ToList();
        var room = _lobby.Rooms.GetValueOrDefault(roomId);

        if (room is { GameType: "minesweeper" })
        {
            // снимок сапёра персональный: террорист видит свои мины
            foreach (var member in members)
                await Clients.Client(member.ConnectionId).SendAsync("MineRoomUpdated",
                    _lobby.GetMineSnapshot(member.ConnectionId));
            return;
        }

        foreach (var member in members)
        {
            await Clients.Client(member.ConnectionId).SendAsync("RoomUpdated",
                _lobby.GetRoomSnapshot(member.ConnectionId));
        }
        await Clients.Group(@group).SendAsync("RoomUpdated", _lobby.GetRoomSnapshot(roomId));
    }

    private async Task SendSystemMessage(string text)
    {
        await Clients.All.SendAsync("ChatMessage", _chat.AddSystem(text));
    }
}
