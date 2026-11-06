using Microsoft.AspNetCore.SignalR;
using TicTacToeSignalR.Hubs;
using TicTacToeSignalR.Services;

var builder = WebApplication.CreateBuilder(args);

// --- Сервисы -------------------------------------------------------------
// SignalR (веб-сокеты)
builder.Services.AddSignalR();

builder.Services.AddSingleton<LeaderboardService>();
builder.Services.AddSingleton<WalletService>();
builder.Services.AddSingleton<ModerationService>();
builder.Services.AddSingleton<ChatService>();
builder.Services.AddSingleton<LobbyService>();

var app = builder.Build();

// --- Middleware ----------------------------------------------------------
app.UseDefaultFiles();
app.UseStaticFiles();

// Когда LobbyService удаляет комнату (хост, модератор или авто-очистка
// неактивных комнат) - сообщаем всем участникам и обновляем лобби.
var lobby = app.Services.GetRequiredService<LobbyService>();
var hubContext = app.Services.GetRequiredService<IHubContext<GameHub>>();
var chat = app.Services.GetRequiredService<ChatService>();

lobby.RoomRemoved += async (room, reason) =>
{
    var groupName = $"room-{room.Id}";
    await hubContext.Clients.Group(groupName).SendAsync("RoomDeleted", reason);
    await hubContext.Clients.All.SendAsync("LobbyUpdated", lobby.GetLobbySnapshot());
    await hubContext.Clients.All.SendAsync("ChatMessage", chat.AddSystem($"Комната «{room.Name}» удалена: {reason}"));
};

app.MapHub<GameHub>("/hubs/game");

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", game = "Tic-Tac-Toe SignalR" }));

app.Run();
