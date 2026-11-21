using PlayHub.Models;

namespace PlayHub.Services;

/// <summary>
/// Модерация: список забаненных имён в App_Data/banned.txt
/// (одна строка — одно имя, регистр не важен) и статистика модераторов
/// в App_Data/mod_stats.txt (Имя;Баны;Кики) — для «работника месяца».
/// </summary>
public class ModerationService
{
    private readonly string _filePath;
    private readonly string _statsPath;
    private readonly object _lock = new();
    private readonly HashSet<string> _banned = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, ModeratorStatDto> _stats = new(StringComparer.OrdinalIgnoreCase);

    public ModerationService(IWebHostEnvironment env)
    {
        var dir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "banned.txt");
        _statsPath = Path.Combine(dir, "mod_stats.txt");
        Load();
        LoadStats();
    }

    public bool IsBanned(string name)
    {
        name = (name ?? "").Trim();
        lock (_lock) { return _banned.Contains(name); }
    }

    public bool Ban(string name)
    {
        name = LeaderboardService.CleanName(name);
        if (name.Length == 0) return false;

        lock (_lock)
        {
            if (!_banned.Add(name)) return false;
            Save();
            return true;
        }
    }

    public bool Unban(string name)
    {
        name = (name ?? "").Trim();
        lock (_lock)
        {
            if (!_banned.Remove(name)) return false;
            Save();
            return true;
        }
    }

    public List<string> GetBannedList()
    {
        lock (_lock) { return _banned.ToList(); }
    }

    // -------------------------------------------------- статистика модераторов

    /// <summary>Записать действие модератора (для «работника месяца»).</summary>
    public void RecordAction(string moderatorName, string action)
    {
        moderatorName = LeaderboardService.CleanName(moderatorName);
        if (moderatorName.Length == 0) return;

        lock (_lock)
        {
            var stat = GetOrCreateStat(moderatorName);
            if (action == "ban") stat.Bans++;
            else if (action == "kick") stat.Kicks++;
            else return;
            SaveStats();
        }
    }

    /// <summary>Таблица модераторов, отсортированная по сумме банов и киков.</summary>
    public List<ModeratorStatDto> GetStats()
    {
        lock (_lock)
        {
            return _stats.Values
                .OrderByDescending(s => s.Total)
                .ThenByDescending(s => s.Bans)
                .ThenBy(s => s.Name)
                .ToList();
        }
    }

    private ModeratorStatDto GetOrCreateStat(string name)
    {
        if (_stats.TryGetValue(name, out var stat)) return stat;
        stat = new ModeratorStatDto { Name = name };
        _stats[name] = stat;
        return stat;
    }

    private void LoadStats()
    {
        try
        {
            if (!File.Exists(_statsPath)) return;
            foreach (var line in File.ReadAllLines(_statsPath))
            {
                var parts = line.Split(';');
                if (parts.Length < 3 || parts[0].Length == 0) continue;
                _stats[parts[0]] = new ModeratorStatDto
                {
                    Name = parts[0],
                    Bans = int.TryParse(parts[1], out var b) ? b : 0,
                    Kicks = int.TryParse(parts[2], out var k) ? k : 0
                };
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось прочитать mod_stats.txt: {ex.Message}");
        }
    }

    private void SaveStats()
    {
        try
        {
            var lines = _stats.Values.Select(s => $"{s.Name};{s.Bans};{s.Kicks}");
            File.WriteAllLines(_statsPath, lines);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось сохранить mod_stats.txt: {ex.Message}");
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            foreach (var line in File.ReadAllLines(_filePath))
            {
                var name = line.Trim();
                if (name.Length > 0) _banned.Add(name);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось прочитать banned.txt: {ex.Message}");
        }
    }

    private void Save()
    {
        try
        {
            File.WriteAllLines(_filePath, _banned);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось сохранить banned.txt: {ex.Message}");
        }
    }
}
