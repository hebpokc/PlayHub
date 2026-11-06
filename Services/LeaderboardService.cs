using TicTacToeSignalR.Models;

namespace TicTacToeSignalR.Services;

/// <summary>
/// Простое сохранение таблицы лидеров в текстовый файл App_Data/leaderboard.txt.
/// Формат строки: Имя;Победы;Ничьи;Поражения
/// </summary>
public class LeaderboardService
{
    private readonly string _filePath;
    private readonly object _lock = new();
    private readonly List<LeaderboardEntry> _entries = new();

    public LeaderboardService(IWebHostEnvironment env)
    {
        var dir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "leaderboard.txt");
        Load();
    }

    /// <summary>Топ игроков: сначала по очкам, потом по победам.</summary>
    public List<LeaderboardEntry> GetTop(int count = 10)
    {
        lock (_lock)
        {
            return _entries
                .OrderByDescending(e => e.Score)
                .ThenByDescending(e => e.Wins)
                .ThenBy(e => e.Name)
                .Take(count)
                .ToList();
        }
    }

    /// <summary>result: "win" | "draw" | "loss"</summary>
    public void AddResult(string name, string result)
    {
        name = CleanName(name);
        if (name.Length == 0) return;

        lock (_lock)
        {
            var entry = _entries.FirstOrDefault(e =>
                string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase));

            if (entry == null)
            {
                entry = new LeaderboardEntry { Name = name };
                _entries.Add(entry);
            }

            switch (result)
            {
                case "win": entry.Wins++; break;
                case "draw": entry.Draws++; break;
                default: entry.Losses++; break;
            }

            Save();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;

            foreach (var line in File.ReadAllLines(_filePath))
            {
                var parts = line.Split(';');
                if (parts.Length < 4) continue;

                _entries.Add(new LeaderboardEntry
                {
                    Name = parts[0],
                    Wins = int.TryParse(parts[1], out var w) ? w : 0,
                    Draws = int.TryParse(parts[2], out var d) ? d : 0,
                    Losses = int.TryParse(parts[3], out var l) ? l : 0
                });
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось прочитать leaderboard.txt: {ex.Message}");
        }
    }

    private void Save()
    {
        try
        {
            var lines = _entries.Select(e => $"{e.Name};{e.Wins};{e.Draws};{e.Losses}");
            File.WriteAllLines(_filePath, lines);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось сохранить leaderboard.txt: {ex.Message}");
        }
    }

    public static string CleanName(string name)
    {
        name = (name ?? "").Trim();
        if (name.Length > 16) name = name[..16];
        return string.IsNullOrEmpty(name) ? "Гость" : name;
    }
}
