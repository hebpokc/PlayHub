namespace TicTacToeSignalR.Services;

/// <summary>
/// Балансы пользователей в текстовом файле App_Data/wallets.txt.
/// Формат строки: Имя;Баланс. Новичку сразу выдаётся стартовый капитал.
/// </summary>
public class WalletService
{
    public const int StartingBalance = 500;
    private const int WinPrize = 100;

    private readonly string _filePath;
    private readonly object _lock = new();
    private readonly Dictionary<string, int> _balances = new(StringComparer.OrdinalIgnoreCase);

    public WalletService(IWebHostEnvironment env)
    {
        var dir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "wallets.txt");
        Load();
    }

    public int GetBalance(string name)
    {
        name = LeaderboardService.CleanName(name);
        lock (_lock)
        {
            return _balances.TryGetValue(name, out var v) ? v : Ensure(name);
        }
    }

    /// <summary>Начислить деньги. Возвращает новый баланс или -1, если некому.</summary>
    public int Add(string name, int amount)
    {
        name = LeaderboardService.CleanName(name);
        if (name.Length == 0) return -1;

        lock (_lock)
        {
            var balance = _balances.TryGetValue(name, out var v) ? v : Ensure(name);
            balance += amount;
            _balances[name] = balance;
            Save();
            return balance;
        }
    }

    /// <summary>Списать ставку. Возвращает true, если денег хватило.</summary>
    public bool TryWithdraw(string name, int amount)
    {
        name = LeaderboardService.CleanName(name);
        if (name.Length == 0 || amount <= 0) return false;

        lock (_lock)
        {
            var balance = _balances.TryGetValue(name, out var v) ? v : Ensure(name);
            if (balance < amount) return false;

            _balances[name] = balance - amount;
            Save();
            return true;
        }
    }

    /// <summary>Создать запись со стартовым капиталом.</summary>
    private int Ensure(string name)
    {
        _balances[name] = StartingBalance;
        Save();
        return StartingBalance;
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;

            foreach (var line in File.ReadAllLines(_filePath))
            {
                var parts = line.Split(';');
                if (parts.Length < 2) continue;
                if (int.TryParse(parts[1], out var amount) && parts[0].Length > 0)
                    _balances[parts[0]] = amount;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось прочитать wallets.txt: {ex.Message}");
        }
    }

    private void Save()
    {
        try
        {
            var lines = _balances.Select(kv => $"{kv.Key};{kv.Value}");
            File.WriteAllLines(_filePath, lines);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось сохранить wallets.txt: {ex.Message}");
        }
    }
}
