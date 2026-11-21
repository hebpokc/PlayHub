using PlayHub.Models;

namespace PlayHub.Services;

/// <summary>
/// Рекорды одиночного сапёра в App_Data/mine_records.txt.
/// Формат строки: Имя;Сложность;ЛучшийСчёт;ЛучшееВремяСек;Игр;Побед.
/// Лучшее время фиксируется только за полностью разминированное поле.
/// </summary>
public class MineRecordService
{
    private readonly string _filePath;
    private readonly object _lock = new();

    /// <summary>Ключ "имя|сложность" -> рекорд.</summary>
    private readonly Dictionary<string, MineRecordDto> _records = new(StringComparer.OrdinalIgnoreCase);

    public MineRecordService(IWebHostEnvironment env)
    {
        var dir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "mine_records.txt");
        Load();
    }

    private static string Key(string name, string difficulty) => $"{name}|{difficulty}";

    /// <summary>Записать итог партии. Возвращает актуальный рекорд игрока.</summary>
    public MineRecordDto Record(string name, string difficulty, int score, int timeSeconds, bool won)
    {
        name = LeaderboardService.CleanName(name);
        lock (_lock)
        {
            var key = Key(name, difficulty);
            if (!_records.TryGetValue(key, out var rec))
            {
                rec = new MineRecordDto { Name = name, Difficulty = difficulty };
                _records[key] = rec;
            }

            rec.Games++;
            if (won) rec.Wins++;
            if (score > rec.BestScore) rec.BestScore = score;
            // лучшее время — только за победу (поле разминировано целиком)
            if (won && (rec.BestTimeSeconds == 0 || timeSeconds < rec.BestTimeSeconds))
                rec.BestTimeSeconds = timeSeconds;

            Save();
            return Clone(rec);
        }
    }

    public MineRecordDto? Get(string name, string difficulty)
    {
        lock (_lock)
        {
            return _records.TryGetValue(Key(LeaderboardService.CleanName(name), difficulty), out var rec)
                ? Clone(rec)
                : null;
        }
    }

    /// <summary>Таблица рекордов: лучший результат каждого игрока на каждой сложности.</summary>
    public List<MineRecordDto> GetTop(int count = 20)
    {
        lock (_lock)
        {
            return _records.Values
                .OrderByDescending(r => r.BestScore)
                .ThenBy(r => r.BestTimeSeconds == 0 ? int.MaxValue : r.BestTimeSeconds)
                .Take(count)
                .Select(Clone)
                .ToList();
        }
    }

    private static MineRecordDto Clone(MineRecordDto r) => new()
    {
        Name = r.Name,
        Difficulty = r.Difficulty,
        BestScore = r.BestScore,
        BestTimeSeconds = r.BestTimeSeconds,
        Games = r.Games,
        Wins = r.Wins
    };

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            foreach (var line in File.ReadAllLines(_filePath))
            {
                var p = line.Split(';');
                if (p.Length < 6) continue;
                if (!int.TryParse(p[2], out var score) ||
                    !int.TryParse(p[3], out var time) ||
                    !int.TryParse(p[4], out var games) ||
                    !int.TryParse(p[5], out var wins)) continue;

                _records[Key(p[0], p[1])] = new MineRecordDto
                {
                    Name = p[0],
                    Difficulty = p[1],
                    BestScore = score,
                    BestTimeSeconds = time,
                    Games = games,
                    Wins = wins
                };
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось прочитать mine_records.txt: {ex.Message}");
        }
    }

    private void Save()
    {
        try
        {
            var lines = _records.Values.Select(r =>
                $"{r.Name};{r.Difficulty};{r.BestScore};{r.BestTimeSeconds};{r.Games};{r.Wins}");
            File.WriteAllLines(_filePath, lines);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось сохранить mine_records.txt: {ex.Message}");
        }
    }
}