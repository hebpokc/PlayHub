namespace TicTacToeSignalR.Models;

/// <summary>
/// Одно сообщение в чате лобби.
/// </summary>
public class ChatMessage
{
    /// <summary>Имя отправителя ("Сервер" для системных сообщений).</summary>
    public string Author { get; set; } = "";

    public string Text { get; set; } = "";

    /// <summary>"X", "O" или "" - чтобы подкрасить имя в чате.</summary>
    public string Side { get; set; } = "";

    /// <summary>true - сообщение от сервера (кто вошёл, матч начался и т.п.).</summary>
    public bool IsSystem { get; set; }

    /// <summary>true - сообщение от модератора.</summary>
    public bool IsModerator { get; set; }

    /// <summary>Готовая строка времени.</summary>
    public string Time { get; set; } = "";
}
