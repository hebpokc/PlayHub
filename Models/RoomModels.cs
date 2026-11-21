namespace PlayHub.Models;

/// <summary>
/// Игровая комната: своя доска, свои игроки и свои ставки.
/// </summary>
public class Room
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "Комната";
    public string HostConnectionId { get; set; } = "";

    /// <summary>Пароль комнаты ("" — открытая). Модератор заходит без пароля.</summary>
    public string Password { get; set; } = "";

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>Партия внутри комнаты (крестики-нолики).</summary>
    public GameState Game { get; set; } = new();

    /// <summary>Какая игра в комнате: "tictactoe" или "minesweeper".</summary>
    public string GameType { get; set; } = "tictactoe";

    /// <summary>Партия сапёра (null для крестиков-ноликов).</summary>
    public MineGameState? Mine { get; set; }

    /// <summary>Ставки наблюдателей в этой комнате.</summary>
    public List<Bet> Bets { get; set; } = new();

    /// <summary>Время последней активности (ход, ставка, вход участника).</summary>
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;

    /// <summary>Отдельный замок на состояние комнаты.</summary>
    public object Sync { get; } = new();

    public void Touch()
    {
        lock (Sync) { LastActiveAt = DateTime.UtcNow; }
    }

    public bool HasMembers(IEnumerable<Player> players) =>
        players.Any(p => p.CurrentRoomId == Id);
}

/// <summary>Ставка наблюдателя на победу игрока X или O.</summary>
public class Bet
{
    public string ConnectionId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Side { get; set; } = "";
    public int Amount { get; set; }
}

public class BetDto
{
    public string Name { get; set; } = "";
    public string Side { get; set; } = "";
    public int Amount { get; set; }
}

/// <summary>Комната в списке лобби.</summary>
public class RoomDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string HostConnectionId { get; set; } = "";
    public string HostName { get; set; } = "";
    public int PlayersCount { get; set; }
    public int SpectatorsCount { get; set; }
    public bool InGame { get; set; }
    public bool HasPassword { get; set; }
    public int PotX { get; set; }
    public int PotO { get; set; }

    /// <summary>"tictactoe" или "minesweeper".</summary>
    public string GameType { get; set; } = "tictactoe";

    /// <summary>Режим сапёра (solo/pvp/asym/cinema), для крестиков — "".</summary>
    public string MineMode { get; set; } = "";

    /// <summary>Сложность сапёра (easy/medium/hard).</summary>
    public string MineDifficulty { get; set; } = "";

    /// <summary>Общий банк сапёра (ante + ставки).</summary>
    public int MineBank { get; set; }
}

/// <summary>Статистика модератора (для «работника месяца»).</summary>
public class ModeratorStatDto
{
    public string Name { get; set; } = "";
    public int Bans { get; set; }
    public int Kicks { get; set; }
    public int Total => Bans + Kicks;
}

/// <summary>Строка таблицы балансов (видит только модератор).</summary>
public class BalanceEntryDto
{
    public string Name { get; set; } = "";
    public int Balance { get; set; }
}

/// <summary>Состояние лобби: комнаты + все онлайн + лидеры.</summary>
public class LobbySnapshot
{
    public List<RoomDto> Rooms { get; set; } = new();
    public List<PlayerDto> Users { get; set; } = new();
    public List<LeaderboardEntry> Leaderboard { get; set; } = new();
}

/// <summary>
/// Полное состояние одной комнаты — отправляется участникам группы
/// после любого события.
/// </summary>
public class RoomSnapshot
{
    public string RoomId { get; set; } = "";
    public string RoomName { get; set; } = "";
    public string HostConnectionId { get; set; } = "";
    public bool IsHost { get; set; }

    public string[] Board { get; set; } = GameState.EmptyBoard();
    public string Turn { get; set; } = "X";
    public bool IsStarted { get; set; }
    public bool IsFinished { get; set; }
    public string Winner { get; set; } = "";
    public bool IsDraw { get; set; }
    public int[] WinLine { get; set; } = new int[0];

    public string PlayerXId { get; set; } = "";
    public string PlayerXName { get; set; } = "";
    public string PlayerOId { get; set; } = "";
    public string PlayerOName { get; set; } = "";

    public List<PlayerDto> Players { get; set; } = new();
    public List<PlayerDto> Spectators { get; set; } = new();

    public bool HasPassword { get; set; }

    public List<BetDto> Bets { get; set; } = new();

    /// <summary>Открыт ли приём ставок (до начала матча).</summary>
    public bool BettingOpen { get; set; }

    /// <summary>Награда победителю — для подсказки в интерфейсе.</summary>
    public int WinnerPrize { get; set; }
}
