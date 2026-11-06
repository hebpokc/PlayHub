namespace TicTacToeSignalR.Models;

/// <summary>
/// Один подключённый пользователь (игрок или наблюдатель).
/// </summary>
public class Player
{
    public string ConnectionId { get; set; } = "";
    public string Name { get; set; } = "Гость";

    /// <summary>"X", "O" или "" - если наблюдатель.</summary>
    public string Side { get; set; } = "";

    /// <summary>Нажал ли кнопку "Готов / Начать матч".</summary>
    public bool IsReady { get; set; }

    /// <summary>Вошёл по паролю модератора.</summary>
    public bool IsModerator { get; set; }

    /// <summary>Id комнаты, где сейчас пользователь ("" — в лобби).</summary>
    public string CurrentRoomId { get; set; } = "";

    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// Состояние текущей партии.
/// </summary>
public class GameState
{
    /// <summary>9 клеток: "" - пусто, "X" или "O".</summary>
    public string[] Board { get; set; } = EmptyBoard();

    public static string[] EmptyBoard() => new string[9] { "", "", "", "", "", "", "", "", "" };

    /// <summary>Чей ход: "X" или "O".</summary>
    public string Turn { get; set; } = "X";

    public bool IsStarted { get; set; }
    public bool IsFinished { get; set; }

    /// <summary>"X", "O" или "" (ничья).</summary>
    public string Winner { get; set; } = "";

    public bool IsDraw { get; set; }

    /// <summary>Клетки выигрышной линии (для подсветки).</summary>
    public int[] WinLine { get; set; } = new int[0];

    /// <summary>ConnectionId игроков.</summary>
    public string PlayerXId { get; set; } = "";
    public string PlayerOId { get; set; } = "";

    public int MoveCount { get; set; }
}

/// <summary>
/// Строка таблицы лидеров (хранится в текстовом файле).
/// </summary>
public class LeaderboardEntry
{
    public string Name { get; set; } = "";
    public int Wins { get; set; }
    public int Draws { get; set; }
    public int Losses { get; set; }

    public int Games => Wins + Draws + Losses;

    /// <summary>Очки: победа = 3, ничья = 1.</summary>
    public int Score => Wins * 3 + Draws;
}

/// <summary>
/// Короткая информация об игроке для отправки в браузер.
/// </summary>
public class PlayerDto
{
    public string ConnectionId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Side { get; set; } = "";
    public bool IsReady { get; set; }
    public bool IsModerator { get; set; }
}

/// <summary>
/// Всё состояние сайта одним объектом - отправляется всем клиентам
/// после любого события (метод "StateUpdated" в site.js).
/// </summary>
public class GameSnapshot
{
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
    public List<LeaderboardEntry> Leaderboard { get; set; } = new();
}
