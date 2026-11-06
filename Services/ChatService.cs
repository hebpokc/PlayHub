using TicTacToeSignalR.Models;

namespace TicTacToeSignalR.Services;

/// <summary>
/// Простой чат лобби: последние 50 сообщений держим в памяти,
/// а весь лог дописываем в текстовый файл App_Data/chat.txt.
/// </summary>
public class ChatService
{
    private const int MaxHistory = 50;
    private const int MaxTextLength = 200;

    private readonly object _lock = new();
    private readonly List<ChatMessage> _messages = new();
    private readonly string _filePath;

    public ChatService(IWebHostEnvironment env)
    {
        var dir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "chat.txt");
    }

    /// <summary>Сообщение от игрока или наблюдателя.</summary>
    public ChatMessage Add(string author, string text, string side, bool isModerator = false)
    {
        var message = new ChatMessage
        {
            Author = author,
            Text = CleanText(text),
            Side = side == "X" || side == "O" ? side : "",
            IsSystem = false,
            IsModerator = isModerator,
            Time = DateTime.Now.ToString("HH:mm")
        };

        Store(message);
        return message;
    }

    /// <summary>Системное сообщение от сервера: кто вошёл, матч начался, победа и т.п.</summary>
    public ChatMessage AddSystem(string text)
    {
        var message = new ChatMessage
        {
            Author = "Сервер",
            Text = CleanText(text),
            Side = "",
            IsSystem = true,
            Time = DateTime.Now.ToString("HH:mm")
        };

        Store(message);
        return message;
    }

    /// <summary>История чата - отдаём новому пользователю сразу после входа.</summary>
    public List<ChatMessage> GetHistory()
    {
        lock (_lock)
        {
            return _messages.ToList();
        }
    }

    /// <summary>Пустое сообщение отправлять нельзя.</summary>
    public static bool IsValid(string? text) => !string.IsNullOrWhiteSpace(text);

    private void Store(ChatMessage message)
    {
        lock (_lock)
        {
            _messages.Add(message);

            // Держим в памяти только последние 50 сообщений
            if (_messages.Count > MaxHistory)
                _messages.RemoveAt(0);
        }

        AppendToFile(message);
    }

    private void AppendToFile(ChatMessage message)
    {
        try
        {
            File.AppendAllText(_filePath, $"[{message.Time}] {message.Author}: {message.Text}{Environment.NewLine}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Не удалось записать chat.txt: {ex.Message}");
        }
    }

    private static string CleanText(string? text)
    {
        text = (text ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
        if (text.Length > MaxTextLength) text = text[..MaxTextLength];
        return text;
    }
}
