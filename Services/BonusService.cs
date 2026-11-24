namespace PlayHub.Services;

/// <summary>Статус бонусов игрока для клиента.</summary>
public class BonusStatusDto
{
    /// <summary>Секунд до следующего бонуса +50 (0 — можно забрать).</summary>
    public int NextBonusSeconds { get; set; }

    /// <summary>Ежедневный бонус +25 ещё не забран сегодня.</summary>
    public bool DailyAvailable { get; set; }
}

/// <summary>
/// Бонусные монеты в текстовом файле App_Data/bonuses.txt.
/// Формат строки: Имя;ПоследнийБонусUTCticks;ПоследнийДневнойUTCticks.
/// +50 монет раз в 15 минут, +25 монет раз в календарные сутки (UTC).
/// </summary>
public class BonusService
{
    public const int TimedAmount = 50;
    public const int DailyAmount = 25;
    private static readonly TimeSpan TimedInterval = TimeSpan.FromMinutes(15);

    private readonly string _filePath;
    private readonly object _lock = new();

    private class BonusRecord
    {
        public DateTime LastTimedUtc = DateTime.MinValue;
        public DateTime LastDailyUtc = DateTime.MinValue;
    }

    private readonly Dictionary<string, BonusRecord> _records = new(StringComparer.OrdinalIgnoreCase);

    public BonusService(IWebHostEnvironment env)
    {
        var dir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "bonuses.txt");
        Load();
    }

    public BonusStatusDto GetStatus(string name)
    {
        name = LeaderboardService.CleanName(name);
        lock (_lock)
        {
            var rec = Get(name);
            var now = DateTime.UtcNow;
            var left = rec.LastTimedUtc + TimedInterval - now;
            return new BonusStatusDto
            {
                NextBonusSeconds = left > TimeSpan.Zero ? (int)Math.Ceiling(left.TotalSeconds) : 0,
                DailyAvailable = rec.LastDailyUtc.Date < now.Date
            };
        }
    }

    /// <summary>Забрать +50. Возвращает null, если таймер ещё не истёк.</summary>
    public int? ClaimTimed(string name)
    {
        name = LeaderboardService.CleanName(name);
        lock (_lock)
        {
            var rec = Get(name);
            var now = DateTime.UtcNow;
            if (rec.LastTimedUtc + TimedInterval > now) return null;

            rec.LastTimedUtc = now;
            Save();
            return TimedAmount;
        }
    }

    /// <summary>Забрать +25 за ежедневный вход. Возвращает null, если уже забран сегодня.</summary>
    public int? ClaimDaily(string name)
    {
        name = LeaderboardService.CleanName(name);
        lock (_lock)
        {
            var rec = Get(name);
            var now = DateTime.UtcNow;
            if (rec.LastDailyUtc.Date >= now.Date) return null;

            rec.LastDailyUtc = now;
            Save();
            return DailyAmount;
        }
    }

    private BonusRecord Get(string name)
    {
        if (!_records.TryGetValue(name, out var rec))
        {
            rec = new BonusRecord();
            _records[name] = rec;
        }
        return rec;
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;

            foreach (var line in File.ReadAllLines(_filePath))
            {
                var parts = line.Split(';');
                if (parts.Length < 3 || parts[0].Length == 0) continue;
                if (!long.TryParse(parts[1], out var timed)) continue;
                if (!long.TryParse(parts[2], out var daily)) continue;

                _records[parts[0]] = new BonusRecord
                {
                    LastTimedUtc = new DateTime(timed, DateTimeKind.Utc),
                    LastDailyUtc = new DateTime(daily, DateTimeKind.Utc)
                };
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось прочитать bonuses.txt: {ex.Message}");
        }
    }

    private void Save()
    {
        try
        {
            var lines = _records.Select(kv =>
                $"{kv.Key};{kv.Value.LastTimedUtc.Ticks};{kv.Value.LastDailyUtc.Ticks}");
            File.WriteAllLines(_filePath, lines);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось сохранить bonuses.txt: {ex.Message}");
        }
    }
}