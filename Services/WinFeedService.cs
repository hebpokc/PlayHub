namespace PlayHub.Services;

/// <summary>Одна запись ленты последних побед.</summary>
public class WinFeedEntry
{
    public string Name { get; set; } = "";
    public int Amount { get; set; }
    public string Game { get; set; } = "";
    public string Time { get; set; } = "";
}

/// <summary>
/// Кольцевой буфер последних побед в памяти: последние N событий,
/// рассылаются всем при входе и при каждой новой победе.
/// </summary>
public class WinFeedService
{
    private const int Capacity = 12;
    private readonly object _lock = new();
    private readonly List<WinFeedEntry> _entries = new();

    public event Action? Changed;

    public void Add(string name, int amount, string game)
    {
        name = LeaderboardService.CleanName(name);
        lock (_lock)
        {
            _entries.Add(new WinFeedEntry
            {
                Name = name,
                Amount = amount,
                Game = game,
                Time = DateTime.UtcNow.ToString("HH:mm")
            });
            if (_entries.Count > Capacity)
                _entries.RemoveRange(0, _entries.Count - Capacity);
        }
        Changed?.Invoke();
    }

    public List<WinFeedEntry> GetLatest(int count = Capacity)
    {
        lock (_lock)
        {
            return _entries.TakeLast(count)
                .Select(e => new WinFeedEntry { Name = e.Name, Amount = e.Amount, Game = e.Game, Time = e.Time })
                .Reverse()
                .ToList();
        }
    }
}