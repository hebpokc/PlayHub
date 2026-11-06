namespace TicTacToeSignalR.Services;

/// <summary>
/// Модерация: список забаненных имён в App_Data/banned.txt
/// (одна строка — одно имя, регистр не важен).
/// </summary>
public class ModerationService
{
    private readonly string _filePath;
    private readonly object _lock = new();
    private readonly HashSet<string> _banned = new(StringComparer.OrdinalIgnoreCase);

    public ModerationService(IWebHostEnvironment env)
    {
        var dir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "banned.txt");
        Load();
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
