namespace PlayHub.Models;

/// <summary>Режим игры в сапёре.</summary>
public static class MineMode
{
    public const string Solo = "solo";
    public const string Pvp = "pvp";
    public const string Asym = "asym";
    public const string Cinema = "cinema";

    public static bool IsValid(string? m) => m is Solo or Pvp or Asym or Cinema;

    /// <summary>В этих режимах игроки вносят ante в банк.</summary>
    public static bool HasAnte(string m) => m is Pvp or Asym or Cinema;
}

/// <summary>Сложность поля сапёра.</summary>
public class MineDifficulty
{
    public string Key { get; init; } = "";
    public string Title { get; init; } = "";
    public int Width { get; init; }
    public int Height { get; init; }
    public int Mines { get; init; }

    public int Cells => Width * Height;

    public static readonly MineDifficulty Easy = new() { Key = "easy", Title = "Лёгкая", Width = 9, Height = 9, Mines = 10 };
    public static readonly MineDifficulty Medium = new() { Key = "medium", Title = "Средняя", Width = 16, Height = 16, Mines = 40 };
    public static readonly MineDifficulty Hard = new() { Key = "hard", Title = "Тяжёлая", Width = 30, Height = 16, Mines = 99 };

    public static MineDifficulty? ByKey(string? key) => key switch
    {
        "easy" => Easy,
        "medium" => Medium,
        "hard" => Hard,
        _ => null
    };
}

/// <summary>Участник партии в сапёре (игрок, не наблюдатель).</summary>
public class MinePlayerState
{
    public string ConnectionId { get; set; } = "";
    public string Name { get; set; } = "";

    /// <summary>Набранные очки в текущей партии.</summary>
    public int Score { get; set; }

    /// <summary>Внесённый ante (0 — не вносил).</summary>
    public int Ante { get; set; }

    /// <summary>Кинотеатр: подорвался и выбыл.</summary>
    public bool IsOut { get; set; }

    /// <summary>
    /// Асим: террорист после расстановки — в партии, но не играет и не выбывает
    /// (он знает расположение мин, поэтому только наблюдает).
    /// </summary>
    public bool IsSpectating { get; set; }

    /// <summary>Асимметричный режим: сейчас террорист (расставляет мины).</summary>
    public bool IsTerrorist { get; set; }

    /// <summary>Нажал «Готов».</summary>
    public bool IsReady { get; set; }
}

/// <summary>
/// Состояние партии в сапёре. Поле генерируется при первом клике
/// (первый ход всегда безопасный).
/// </summary>
public class MineGameState
{
    // --- настройки комнаты (фиксируются при создании)
    public string Mode { get; set; } = MineMode.Solo;
    public MineDifficulty Difficulty { get; set; } = MineDifficulty.Easy;

    /// <summary>Ставка, которую вносит каждый игрок (PvP/Кинотеатр/Асим).</summary>
    public int Ante { get; set; } = 10;

    // --- поле
    public int Width => Difficulty.Width;
    public int Height => Difficulty.Height;
    public int MineCount => Difficulty.Mines;

    /// <summary>Мины разложены (после первого безопасного клика).</summary>
    public bool MinesPlaced { get; set; }
    public bool[] Mines { get; set; } = Array.Empty<bool>();

    /// <summary>Число мин вокруг клетки (пересчитывается при расстановке).</summary>
    public int[] Numbers { get; set; } = Array.Empty<int>();

    public bool[] Opened { get; set; } = Array.Empty<bool>();
    public bool[] Flagged { get; set; } = Array.Empty<bool>();

    // --- ход партии
    public bool IsStarted { get; set; }
    public bool IsFinished { get; set; }

    /// <summary>Асим: фаза расстановки мин террористом.</summary>
    public bool IsPlacing { get; set; }

    /// <summary>ConnectionId игрока, чей сейчас ход ("" — нет хода).</summary>
    public string TurnId { get; set; } = "";

    /// <summary>Дедлайн текущего хода/фазы (UTC).</summary>
    public DateTime? TurnDeadline { get; set; }

    /// <summary>Начало партии (для таймера одиночки).</summary>
    public DateTime StartedAt { get; set; }

    /// <summary>Конец партии (для фиксации времени).</summary>
    public DateTime FinishedAt { get; set; }

    /// <summary>Клетка подрыва (-1 — не было).</summary>
    public int ExplodedIndex { get; set; } = -1;

    /// <summary>ConnectionId победителя ("" — ничья/нет).</summary>
    public string WinnerId { get; set; } = "";
    public string WinnerName { get; set; } = "";
    public bool IsDraw { get; set; }

    /// <summary>Выплата победителю из банка (после комиссии 5%).</summary>
    public int WinnerPayout { get; set; }

    /// <summary>Итоговое время партии в секундах.</summary>
    public int ElapsedSeconds { get; set; }

    /// <summary>Участники партии.</summary>
    public List<MinePlayerState> Participants { get; set; } = new();

    /// <summary>Асим: номер партии для чередования ролей.</summary>
    public int RoundNumber { get; set; }

    /// <summary>
    /// Одиночка: до этого момента место игрока зарезервировано за хостом.
    /// Null — резерв не действует (хост уже играет или время вышло).
    /// </summary>
    public DateTime? HostSeatReservedUntil { get; set; }

    public MinePlayerState? Find(string connectionId) =>
        Participants.FirstOrDefault(p => p.ConnectionId == connectionId);

    public int Bank => Participants.Sum(p => p.Ante);

    /// <summary>Все безопасные клетки открыты?</summary>
    public bool AllSafeOpened()
    {
        for (var i = 0; i < Opened.Length; i++)
            if (!Mines[i] && !Opened[i]) return false;
        return true;
    }

    /// <summary>Подготовить пустое поле под размер сложности.</summary>
    public void InitField()
    {
        var n = Difficulty.Cells;
        Mines = new bool[n];
        Numbers = new int[n];
        Opened = new bool[n];
        Flagged = new bool[n];
        MinesPlaced = false;
    }
}

/// <summary>Участник сапёра для клиента.</summary>
public class MineParticipantDto
{
    public string ConnectionId { get; set; } = "";
    public string Name { get; set; } = "";
    public int Score { get; set; }
    public int Ante { get; set; }
    public bool IsOut { get; set; }
    public bool IsSpectating { get; set; }
    public bool IsTerrorist { get; set; }
    public bool IsReady { get; set; }
}

/// <summary>
/// Снимок комнаты сапёра для клиента. Мины скрыты, пока партия идёт:
/// наружу отдаются только открытые клетки, флажки и числа открытых клеток.
/// </summary>
public class MineSnapshot
{
    public string RoomId { get; set; } = "";
    public string RoomName { get; set; } = "";
    public string HostConnectionId { get; set; } = "";
    public bool IsHost { get; set; }
    public bool HasPassword { get; set; }

    public string Mode { get; set; } = "";
    public string DifficultyKey { get; set; } = "";
    public string DifficultyTitle { get; set; } = "";
    public int Width { get; set; }
    public int Height { get; set; }
    public int MineCount { get; set; }
    public int Ante { get; set; }

    /// <summary>
    /// Код клетки для клиента:
    /// -1 закрыта, -2 флаг, -3 мина (взорвалась/показана), 0..8 открытое число.
    /// </summary>
    public int[] Cells { get; set; } = Array.Empty<int>();

    /// <summary>Индексы мин — только после окончания партии.</summary>
    public int[] MineIndexes { get; set; } = Array.Empty<int>();

    public bool IsStarted { get; set; }
    public bool IsFinished { get; set; }
    public bool IsPlacing { get; set; }

    public string TurnId { get; set; } = "";
    public string TurnName { get; set; } = "";

    /// <summary>Секунд до конца хода/расстановки (null — таймера нет).</summary>
    public int? TurnSecondsLeft { get; set; }

    /// <summary>Секунд с начала партии.</summary>
    public int ElapsedSeconds { get; set; }

    public int ExplodedIndex { get; set; } = -1;
    public string WinnerId { get; set; } = "";
    public string WinnerName { get; set; } = "";
    public bool IsDraw { get; set; }
    public int WinnerPayout { get; set; }
    public int Bank { get; set; }

    /// <summary>Сколько мин ещё не помечено (счётчик флажков).</summary>
    public int FlagsLeft { get; set; }

    /// <summary>Асим: сколько мин уже расставил террорист.</summary>
    public int MinesPlacedByTerrorist { get; set; }

    /// <summary>Одиночка: место зарезервировано за хостом ещё N секунд.</summary>
    public int HostSeatSecondsLeft { get; set; }

    /// <summary>Кинотеатр: сколько игроков ещё нужно до старта.</summary>
    public int PlayersNeeded { get; set; }

    /// <summary>Мой лучший результат (одиночка).</summary>
    public MineRecordDto? MyRecord { get; set; }

    public List<MineParticipantDto> Participants { get; set; } = new();
    public List<PlayerDto> Spectators { get; set; } = new();

    public List<BetDto> Bets { get; set; } = new();
    public bool BettingOpen { get; set; }
}

/// <summary>Личный рекорд в одиночном сапёре.</summary>
public class MineRecordDto
{
    public string Name { get; set; } = "";
    public string Difficulty { get; set; } = "";
    public int BestScore { get; set; }
    public int BestTimeSeconds { get; set; }
    public int Games { get; set; }
    public int Wins { get; set; }
}

/// <summary>Результат действия в сапёре для хаба.</summary>
public enum MineActionResult
{
    Ok,
    NoRoom,
    NotParticipant,
    NotStarted,
    Finished,
    NotYourTurn,
    BadIndex,
    AlreadyOpened,
    IsFlagged,
    PlacingPhase,
    NotPlacingPhase
}