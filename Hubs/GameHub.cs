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

    public GameHub(LobbyService lobby, ChatService chat, WalletService wallets, ModerationService moderation)
    {
        _lobby = lobby;
        _chat = chat;
        _wallets = wallets;
        _moderation = moderation;
    }

    /// <summary>Шаг 1. Вход по имени. Модератор указывает доп. пароль.</summary>
    public async Task Join(string? name, string? moderatorPassword)
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

        _lobby.AddPlayer(Context.ConnectionId, playerName, isModerator);

        await Clients.Caller.SendAsync("Welcome", new
        {
            connectionId = Context.ConnectionId,
            name = playerName,
            isModerator,
            balance = _wallets.GetBalance(playerName)
        });

        await Clients.Caller.SendAsync("ChatHistory", _chat.GetHistory());
        await Clients.All.SendAsync("UserJoined", playerName);
        await SendSystemMessage(isModerator
            ? $"{playerName} зашёл на сайт как модератор 🛡"
            : $"{playerName} зашёл на сайт");
        await BroadcastLobby();
    }

    // --------------------------------------------------------------- комнаты

    public async Task CreateRoom(string? roomName, string? password)
    {
        var room = _lobby.CreateRoom(Context.ConnectionId, roomName ?? "", password);
        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(room.Id));
        await SendSystemMessage($"{_lobby.GetName(Context.ConnectionId)} создал комнату «{room.Name}»" +
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

        _lobby.LeaveRoom(Context.ConnectionId);
        if (room != null) await Groups.RemoveFromGroupAsync(Context.ConnectionId, RoomGroup(room.Id));

        if (roomName != "")
            await SendSystemMessage($"{_lobby.GetName(Context.ConnectionId)} покинул комнату «{roomName}»");

        await BroadcastLobby();
        if (room != null) await BroadcastRoom(room.Id);
        await Clients.Caller.SendAsync("RoomLeft");
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
        if (room == null) return;

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

            // обновляем балансы всем в комнате
            foreach (var p in _lobby.Players.Values.Where(p => p.CurrentRoomId == room.Id))
                await Clients.Client(p.ConnectionId).SendAsync("BalanceUpdated", _wallets.GetBalance(p.Name));
        }
    }

    public async Task Restart()
    {
        var player = _lobby.GetPlayer(Context.ConnectionId);
        var room = player == null ? null : _lobby.GetRoomOf(player);
        if (room == null) return;

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

        var isHost = room.HostConnectionId == Context.ConnectionId;
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

        _lobby.RemovePlayer(Context.ConnectionId);

        if (player != null)
        {
            await Clients.All.SendAsync("UserLeft", player.Name);
            await SendSystemMessage($"{player.Name} покинул сайт");
        }

        await BroadcastLobby();
        if (room != null) await BroadcastRoom(room.Id);
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
    }

    private async Task SendRoomToCaller()
    {
        await Clients.Caller.SendAsync("RoomUpdated", _lobby.GetRoomSnapshot(Context.ConnectionId));
    }

    private async Task BroadcastRoom(string roomId)
    {
        var group = RoomGroup(roomId);
        var members = _lobby.Players.Values.Where(p => p.CurrentRoomId == roomId).ToList();
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
