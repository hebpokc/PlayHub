namespace PlayHub.Services;

/// <summary>
/// Эмодзи-аватары игроков в App_Data/avatars.txt. Формат: Имя;Аватар.
/// Аватар выбирается на экране входа и виден всем в списках и presence-ряду.
/// </summary>
public class AvatarService
{
    public const string DefaultAvatar = "😎";

    /// <summary>Разрешённые аватары — тот же список, что в picker на клиенте.</summary>
    public static readonly string[] Allowed = { "😎", "🦊", "👾", "🐸", "🤖", "🦄", "🐼", "🐙", "🐯", "🐺", "🦁", "🐲" };

    private readonly string _filePath;
    private readonly object _lock = new();
    private readonly Dictionary<string, string> _avatars = new(StringComparer.OrdinalIgnoreCase);

    public AvatarService(IWebHostEnvironment env)
    {
        var dir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "avatars.txt");
        Load();
    }

    public string Get(string name)
    {
        name = LeaderboardService.CleanName(name);
        lock (_lock)
        {
            return _avatars.TryGetValue(name, out var av) ? av : DefaultAvatar;
        }
    }

    /// <summary>Сохранить аватар. Неразрешённый эмодзи заменяется стандартным.</summary>
    public string Set(string name, string? avatar)
    {
        name = LeaderboardService.CleanName(name);
        avatar = Allowed.Contains(avatar ?? "") ? avatar! : DefaultAvatar;
        lock (_lock)
        {
            _avatars[name] = avatar;
            Save();
            return avatar;
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
                if (parts.Length < 2 || parts[0].Length == 0) continue;
                if (Allowed.Contains(parts[1]))
                    _avatars[parts[0]] = parts[1];
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось прочитать avatars.txt: {ex.Message}");
        }
    }

    private void Save()
    {
        try
        {
            var lines = _avatars.Select(kv => $"{kv.Key};{kv.Value}");
            File.WriteAllLines(_filePath, lines);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось сохранить avatars.txt: {ex.Message}");
        }
    }
}