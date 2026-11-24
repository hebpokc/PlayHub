using Microsoft.AspNetCore.SignalR;
using PlayHub.Hubs;
using PlayHub.Services;

var builder = WebApplication.CreateBuilder(args);

// --- Сервисы -------------------------------------------------------------
// SignalR (веб-сокеты)
builder.Services.AddSignalR();

builder.Services.AddSingleton<LeaderboardService>();
builder.Services.AddSingleton<WalletService>();
builder.Services.AddSingleton<ModerationService>();
builder.Services.AddSingleton<ChatService>();
builder.Services.AddSingleton<MineRecordService>();
builder.Services.AddSingleton<MinesweeperService>();
builder.Services.AddSingleton<LobbyService>();
builder.Services.AddSingleton<AvatarService>();
builder.Services.AddSingleton<BonusService>();
builder.Services.AddSingleton<WinFeedService>();

var app = builder.Build();

// --- Middleware ----------------------------------------------------------
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    // не даём браузеру залипнуть на старых js/css после деплоя:
    // каждый запрос сверяется с сервером по ETag/Last-Modified
    OnPrepareResponse = ctx =>
    {
        ctx.Context.Response.Headers.CacheControl = "no-cache";
    }
});

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

// Лента последних побед: новая запись → рассылаем всем (гостям и игрокам).
var winFeed = app.Services.GetRequiredService<WinFeedService>();
winFeed.Changed += () =>
{
    var latest = winFeed.GetLatest();
    hubContext.Clients.All.SendAsync("WinFeed", latest);
};

app.MapHub<GameHub>("/hubs/game");

// Таймер сапёра: раз в секунду проверяем дедлайны ходов и расстановки мин.
// Если состояние изменилось — рассылаем персональные снимки участникам.
var mineTimer = new Timer(async _ =>
{
    try
    {
        foreach (var room in lobby.TickMines())
        {
            var members = lobby.Players.Values.Where(p => p.CurrentRoomId == room.Id).ToList();
            foreach (var member in members)
            {
                await hubContext.Clients.Client(member.ConnectionId)
                    .SendAsync("MineRoomUpdated", lobby.GetMineSnapshot(member.ConnectionId));
            }

            var g = room.Mine!;
            if (g.IsFinished)
            {
                await hubContext.Clients.Group($"room-{room.Id}").SendAsync("MineGameFinished", new
                {
                    winnerId = g.WinnerId,
                    winnerName = g.WinnerName,
                    isDraw = g.IsDraw,
                    payout = g.WinnerPayout,
                    explodedIndex = g.ExplodedIndex
                });
                await hubContext.Clients.All.SendAsync("ChatMessage", chat.AddSystem(g.IsDraw
                    ? "Сапёр: ничья по таймеру 🤝 — ставки возвращены"
                    : $"Сапёр: {g.WinnerName} побеждает! 🎉"));
                await hubContext.Clients.All.SendAsync("LobbyUpdated", lobby.GetLobbySnapshot());
            }
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Ошибка таймера сапёра: {ex.Message}");
    }
}, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", hub = "PlayHub" }));

app.Run();
