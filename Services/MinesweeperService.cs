using PlayHub.Models;

namespace PlayHub.Services;

/// <summary>
/// Игровая логика сапёра: генерация поля, ходы, таймеры, очки, расчёт банка.
/// Работает поверх Room.Mine под замком комнаты (room.Sync).
/// </summary>
public class MinesweeperService
{
    public const int MinAnte = 10;
    public const double HouseFee = 0.05;

    private const int PvpBaseTurnSeconds = 30;
    private const int PvpTimeoutPenalty = 5;
    private const int AsymPlaceSeconds = 60;
    private const int SoloHostSeatSeconds = 10;

    private readonly WalletService _wallets;
    private readonly MineRecordService _records;
    private readonly LeaderboardService _leaderboard;
    private readonly Random _rng = new();

    public MinesweeperService(WalletService wallets, MineRecordService records, LeaderboardService leaderboard)
    {
        _wallets = wallets;
        _records = records;
        _leaderboard = leaderboard;
    }

    // ------------------------------------------------------------ участники

    /// <summary>Занять место игрока. Возвращает текст ошибки или "ok".</summary>
    public string JoinGame(Room room, Player player)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            if (g.Find(player.ConnectionId) != null) return "ok";
            if (g.IsStarted && !g.IsFinished) return "Партия уже идёт — дождитесь окончания.";

            // одиночка: первые 10 секунд место держит хост комнаты
            if (g.Mode == MineMode.Solo && player.ConnectionId != room.HostConnectionId &&
                g.HostSeatReservedUntil is { } until && DateTime.UtcNow < until)
            {
                var left = (int)Math.Ceiling((until - DateTime.UtcNow).TotalSeconds);
                return $"Место зарезервировано за хостом ещё {left} с.";
            }

            var max = MaxPlayers(g.Mode);
            if (g.Participants.Count >= max) return $"В этом режиме максимум {max} игрок(а).";

            g.Participants.Add(new MinePlayerState
            {
                ConnectionId = player.ConnectionId,
                Name = player.Name
            });

            // хост сел играть (или место занято) — резерв больше не нужен
            if (g.Mode == MineMode.Solo) g.HostSeatReservedUntil = null;

            room.Touch();
            return "ok";
        }
    }

    /// <summary>Установить резерв места за хостом при создании одиночной комнаты.</summary>
    public void ReserveHostSeat(Room room)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            g.HostSeatReservedUntil = DateTime.UtcNow.AddSeconds(SoloHostSeatSeconds);
        }
    }

    /// <summary>Покинуть место игрока. Во время партии — автопроигрыш.</summary>
    public void LeaveGame(Room room, string connectionId)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            var p = g.Find(connectionId);
            if (p == null) return;

            if (g.IsStarted && !g.IsFinished)
            {
                // асим: террорист-наблюдатель ушёл — сапёр продолжает разминировать
                if (g.Mode == MineMode.Asym && p.IsSpectating)
                {
                    p.IsOut = true;
                    room.Touch();
                    return;
                }

                // асим: сапёр ушёл или сдался в фазе расстановки — побеждает террорист
                if (g.Mode == MineMode.Asym)
                {
                    p.IsOut = true;
                    var terrorist = g.Participants.First(x => x.IsTerrorist);
                    terrorist.IsSpectating = false;
                    FinishWithWinner(room, terrorist);
                    room.Touch();
                    return;
                }

                // отключение во время партии = поражение
                p.IsOut = true;
                if (g.Mode == MineMode.Solo)
                {
                    FinishSolo(room, won: false, exploded: -1);
                }
                else
                {
                    CheckWinByElimination(room);
                    if (!g.IsFinished && g.TurnId == connectionId)
                        AdvanceTurn(room);
                }
            }
            else
            {
                // возврат ante только до старта: после партии банк уже рассчитан
                if (!g.IsStarted && p.Ante > 0) _wallets.Add(p.Name, p.Ante);

                // ставки на ушедшего игрока до старта возвращаются
                if (!g.IsStarted)
                {
                    foreach (var bet in room.Bets.Where(b => b.Side == connectionId))
                        _wallets.Add(bet.Name, bet.Amount);
                    room.Bets.RemoveAll(b => b.Side == connectionId);
                }
                g.Participants.Remove(p);
            }

            // сброс готовности остальных при изменении состава до старта
            if (!g.IsStarted)
                foreach (var other in g.Participants) other.IsReady = false;

            room.Touch();
        }
    }

    public static int MaxPlayers(string mode) => mode switch
    {
        MineMode.Solo => 1,
        MineMode.Pvp => 2,
        MineMode.Asym => 2,
        MineMode.Cinema => 8,
        _ => 1
    };

    public static int MinPlayers(string mode) => mode switch
    {
        MineMode.Cinema => 3,
        MineMode.Pvp => 2,
        MineMode.Asym => 2,
        _ => 1
    };

    // ------------------------------------------------------------- готовность

    /// <summary>
    /// «Готов»: вносит ante (если режим платный) и проверяет старт.
    /// Возвращает ("ok"/текст ошибки, started).
    /// </summary>
    public (string Result, bool Started) SetReady(Room room, string connectionId, int ante)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            var p = g.Find(connectionId);
            if (p == null) return ("Сначала займите место игрока.", false);
            if (g.IsStarted && !g.IsFinished) return ("Партия уже идёт.", false);
            if (g.IsFinished) return ("Партия окончена — нажмите «Играть снова».", false);

            if (MineMode.HasAnte(g.Mode))
            {
                if (ante < MinAnte) return ($"Минимальная ставка — {MinAnte} монет.", false);
                if (p.Ante == 0)
                {
                    if (!_wallets.TryWithdraw(p.Name, ante))
                        return ("Недостаточно денег на балансе.", false);
                    p.Ante = ante;
                }
            }

            p.IsReady = true;
            room.Touch();

            var min = MinPlayers(g.Mode);
            var allReady = g.Participants.Count >= min && g.Participants.All(x => x.IsReady);
            if (!allReady) return ("ok", false);

            Start(room);
            return ("ok", true);
        }
    }

    /// <summary>Старт партии.</summary>
    private void Start(Room room)
    {
        var g = room.Mine!;
        g.InitField();
        g.IsStarted = true;
        g.IsFinished = false;
        g.IsDraw = false;
        g.WinnerId = "";
        g.WinnerName = "";
        g.WinnerPayout = 0;
        g.ExplodedIndex = -1;
        g.AsymClicks = 0;
        g.TerroristPayout = 0;
        g.SapperPayout = 0;
        g.StartedAt = DateTime.UtcNow;
        foreach (var p in g.Participants) { p.Score = 0; p.IsOut = false; p.IsSpectating = false; }

        if (g.Mode == MineMode.Asym)
        {
            // террорист чередуется по номеру партии
            for (var i = 0; i < g.Participants.Count; i++)
                g.Participants[i].IsTerrorist = (i + g.RoundNumber) % 2 == 0;
            g.IsPlacing = true;
            g.TurnId = g.Participants.First(p => p.IsTerrorist).ConnectionId;
            g.TurnDeadline = DateTime.UtcNow.AddSeconds(AsymPlaceSeconds);
        }
        else
        {
            g.IsPlacing = false;
            g.TurnId = g.Participants[0].ConnectionId;
            g.TurnDeadline = g.Mode == MineMode.Solo ? null : DateTime.UtcNow.AddSeconds(TurnSeconds(g));
        }
    }

    /// <summary>Базовый таймер хода PvP: 30с + 5с за каждое число >= 4 на поле.</summary>
    private static int TurnSeconds(MineGameState g)
    {
        if (g.Mode == MineMode.Cinema) return 20;
        var hard = g.MinesPlaced ? g.Numbers.Count(n => n >= 4) : 0;
        return PvpBaseTurnSeconds + hard * 5;
    }

    /// <summary>Множитель за скорость хода: 1.0 + max(0,(30-t)/30)*1.5.</summary>
    public static double SpeedMultiplier(double secondsSpent) =>
        1.0 + Math.Max(0, (30 - secondsSpent) / 30) * 1.5;

    // ------------------------------------------------------------ расстановка

    /// <summary>Асим: террорист ставит/снимает мину. Возвращает результат.</summary>
    public MineActionResult PlaceMine(Room room, string connectionId, int index)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            if (!g.IsStarted) return MineActionResult.NotStarted;
            if (g.IsFinished) return MineActionResult.Finished;
            if (!g.IsPlacing) return MineActionResult.NotPlacingPhase;
            if (g.TurnId != connectionId) return MineActionResult.NotYourTurn;
            if (index < 0 || index >= g.Difficulty.Cells) return MineActionResult.BadIndex;

            var placed = g.Mines.Count(m => m);
            if (!g.Mines[index] && placed >= g.MineCount) return MineActionResult.BadIndex;

            g.Mines[index] = !g.Mines[index];
            RecalcNumbers(g);
            g.MinesPlaced = true;
            room.Touch();
            return MineActionResult.Ok;
        }
    }

    /// <summary>Асим: террорист закончил расстановку (или автостарт по таймеру).</summary>
    public bool FinishPlacing(Room room, string? connectionId, bool auto = false)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            if (!g.IsPlacing || g.IsFinished) return false;
            if (!auto && g.TurnId != connectionId) return false;

            var placed = g.Mines.Count(m => m);
            if (!auto && placed < g.MineCount) return false;

            // авто: добираем недостающие мины случайно
            if (placed < g.MineCount)
            {
                var free = Enumerable.Range(0, g.Difficulty.Cells).Where(i => !g.Mines[i]).ToList();
                while (placed < g.MineCount && free.Count > 0)
                {
                    var pick = free[_rng.Next(free.Count)];
                    free.Remove(pick);
                    g.Mines[pick] = true;
                    placed++;
                }
                RecalcNumbers(g);
            }

            g.MinesPlaced = true;
            g.IsPlacing = false;
            var sapper = g.Participants.First(p => !p.IsTerrorist);

            // террорист знает, где мины — дальше он только наблюдает за разминированием
            foreach (var t in g.Participants.Where(p => p.IsTerrorist)) t.IsSpectating = true;

            g.AsymClicks = 0;
            g.TurnId = sapper.ConnectionId;
            g.TurnDeadline = null; // сапёр играет без таймера хода
            g.StartedAt = DateTime.UtcNow;
            room.Touch();
            return true;
        }
    }

    // ---------------------------------------------------------------- ходы

    /// <summary>
    /// Открыть клетку. firstClickSafe — генерация поля при первом ходе.
    /// Возвращает результат и очки за ход (для анимации на клиенте).
    /// </summary>
    public (MineActionResult Result, int Points, bool Exploded) Open(Room room, string connectionId, int index)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            var p = g.Find(connectionId);
            if (p == null || p.IsOut || p.IsSpectating) return (MineActionResult.NotParticipant, 0, false);
            if (!g.IsStarted) return (MineActionResult.NotStarted, 0, false);
            if (g.IsFinished) return (MineActionResult.Finished, 0, false);
            if (g.IsPlacing) return (MineActionResult.PlacingPhase, 0, false);
            if (g.Mode != MineMode.Solo && g.TurnId != connectionId) return (MineActionResult.NotYourTurn, 0, false);
            if (index < 0 || index >= g.Difficulty.Cells) return (MineActionResult.BadIndex, 0, false);
            if (g.Opened[index]) return (MineActionResult.AlreadyOpened, 0, false);
            if (g.Flagged[index]) return (MineActionResult.IsFlagged, 0, false);

            // первый ход всегда безопасный: раскладываем мины, исключая клик и соседей
            if (!g.MinesPlaced)
            {
                GenerateMines(g, index);
                g.StartedAt = DateTime.UtcNow;
                if (g.Mode != MineMode.Solo)
                    g.TurnDeadline = DateTime.UtcNow.AddSeconds(TurnSeconds(g));
            }

            var turnStart = g.TurnDeadline?.AddSeconds(-TurnSeconds(g)) ?? DateTime.UtcNow;
            var spent = (DateTime.UtcNow - turnStart).TotalSeconds;
            room.Touch();

            // подорвался
            if (g.Mines[index])
            {
                g.Opened[index] = true;
                g.ExplodedIndex = index;
                p.IsOut = true;

                if (g.Mode == MineMode.Solo)
                {
                    FinishSolo(room, won: false, exploded: index);
                }
                else if (g.Mode == MineMode.Asym)
                {
                    var terrorist = g.Participants.First(x => x.IsTerrorist);
                    terrorist.IsSpectating = false;
                    FinishWithWinner(room, terrorist);
                }
                else
                {
                    CheckWinByElimination(room);
                    if (!g.IsFinished) AdvanceTurn(room);
                }
                return (MineActionResult.Ok, 0, true);
            }

            // безопасная клетка: открываем каскадом нули, очки за все открытые клетки
            var openedCount = FloodOpen(g, index);
            var basePoints = openedCount.points;

            var points = g.Mode == MineMode.Pvp
                ? (int)Math.Round(basePoints * SpeedMultiplier(spent))
                : basePoints;

            // асим: награда растёт с каждым успешным открытием —
            // n-й клик даёт n × очки клетки, копится право на долю банка
            if (g.Mode == MineMode.Asym)
            {
                g.AsymClicks++;
                points *= g.AsymClicks;
            }
            p.Score += points;

            // полное разминирование
            if (g.AllSafeOpened())
            {
                if (g.Mode == MineMode.Solo) FinishSolo(room, won: true, exploded: -1);
                else if (g.Mode == MineMode.Asym) FinishWithWinner(room, p);
                else FinishByScore(room);
                return (MineActionResult.Ok, points, false);
            }

            if (g.Mode != MineMode.Solo)
            {
                // асим: играет один сапёр и без таймера хода
                if (g.Mode == MineMode.Asym)
                {
                    g.TurnId = p.ConnectionId;
                    g.TurnDeadline = null;
                }
                else
                {
                    // PvP: открыт ноль — бонусный дополнительный ход (без продления таймера)
                    var bonus = g.Numbers[index] == 0;
                    if (!bonus) AdvanceTurn(room);
                }
            }

            return (MineActionResult.Ok, points, false);
        }
    }

    /// <summary>
    /// Асим-риск: доля банка сапёра при кэшауте. Каждый успешный клик открывает
    /// право на 2% банка, максимум 90%. Уже после первого клика можно забрать
    /// небольшой выигрыш, но «открыл одну и ушёл» даёт меньше внесённого ante.
    /// </summary>
    public static int CashOutShare(MineGameState g)
    {
        var share = Math.Min(0.9, g.AsymClicks * 0.02);
        return (int)Math.Floor(g.Bank * (1 - HouseFee) * share);
    }

    /// <summary>
    /// Асим-риск: сапёр забирает накопленную долю банка и завершает партию.
    /// Террорист получает остаток банка (минус комиссия) — его награда за риск.
    /// </summary>
    public (MineActionResult Result, int SapperPayout, int TerroristPayout) CashOut(Room room, string connectionId)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            if (g.Mode != MineMode.Asym) return (MineActionResult.NotParticipant, 0, 0);
            var p = g.Find(connectionId);
            if (p == null || p.IsOut || p.IsSpectating) return (MineActionResult.NotParticipant, 0, 0);
            if (!g.IsStarted || g.IsPlacing) return (MineActionResult.NotStarted, 0, 0);
            if (g.IsFinished) return (MineActionResult.Finished, 0, 0);
            if (g.AsymClicks == 0) return (MineActionResult.NotStarted, 0, 0);

            var sapperShare = CashOutShare(g);
            var bank = g.Bank;
            var terrorist = g.Participants.First(x => x.IsTerrorist);
            var netBank = (int)Math.Floor(bank * (1 - HouseFee));
            var terroristShare = Math.Max(0, netBank - sapperShare);

            g.IsFinished = true;
            g.FinishedAt = DateTime.UtcNow;
            g.ElapsedSeconds = (int)(g.FinishedAt - g.StartedAt).TotalSeconds;
            g.TurnDeadline = null;
            g.IsDraw = false;
            g.ExplodedIndex = -1;

            // банк делится по долям: сапёр выиграл, если забрал больше террориста
            var sapperWon = sapperShare >= terroristShare;
            var winner = sapperWon ? p : terrorist;
            g.WinnerId = winner.ConnectionId;
            g.WinnerName = winner.Name;
            g.WinnerPayout = sapperWon ? sapperShare : terroristShare;
            g.TerroristPayout = terroristShare;
            g.SapperPayout = sapperShare;

            terrorist.IsSpectating = false;
            if (sapperShare > 0) _wallets.Add(p.Name, sapperShare);
            if (terroristShare > 0) _wallets.Add(terrorist.Name, terroristShare);

            // ставки наблюдателей: пул делится между угадавшими (−5%)
            var winners = room.Bets.Where(b => b.Side == winner.ConnectionId).ToList();
            if (winners.Count > 0)
            {
                var pool = room.Bets.Sum(b => b.Amount);
                var winnersSum = winners.Sum(b => b.Amount);
                foreach (var bet in winners)
                {
                    var share = (int)Math.Floor(pool * (1 - HouseFee) * bet.Amount / winnersSum);
                    if (share > 0) _wallets.Add(bet.Name, share);
                }
            }
            room.Bets.Clear();

            _leaderboard.AddResult(winner.Name, "win");
            _leaderboard.AddResult(sapperWon ? terrorist.Name : p.Name, "loss");

            room.Touch();
            return (MineActionResult.Ok, sapperShare, terroristShare);
        }
    }

    /// <summary>Поставить/снять флажок.</summary>
    public MineActionResult ToggleFlag(Room room, string connectionId, int index)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            var p = g.Find(connectionId);
            if (p == null || p.IsOut || p.IsSpectating) return MineActionResult.NotParticipant;
            if (!g.IsStarted) return MineActionResult.NotStarted;
            if (g.IsFinished) return MineActionResult.Finished;
            if (g.IsPlacing) return MineActionResult.PlacingPhase;
            if (g.Mode != MineMode.Solo && g.TurnId != connectionId) return MineActionResult.NotYourTurn;
            if (index < 0 || index >= g.Difficulty.Cells) return MineActionResult.BadIndex;
            if (g.Opened[index]) return MineActionResult.AlreadyOpened;

            g.Flagged[index] = !g.Flagged[index];
            room.Touch();

            // асим: сапёр победил, если все мины помечены и флажков ровно по числу мин
            if (g.Mode == MineMode.Asym && g.MinesPlaced)
            {
                var flags = g.Flagged.Count(f => f);
                if (flags == g.MineCount && Enumerable.Range(0, g.Difficulty.Cells).All(i => !g.Flagged[i] || g.Mines[i]))
                {
                    FinishWithWinner(room, p);
                }
            }
            return MineActionResult.Ok;
        }
    }

    /// <summary>Сдаться: игрок признаёт поражение.</summary>
    public bool Surrender(Room room, string connectionId)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            var p = g.Find(connectionId);
            if (p == null || !g.IsStarted || g.IsFinished) return false;

            // террорист во время расстановки сдаётся — сапёр побеждает;
            // после расстановки он уже наблюдатель и сдаться не может
            if (p.IsSpectating) return false;

            p.IsOut = true;
            if (g.Mode == MineMode.Solo)
            {
                FinishSolo(room, won: false, exploded: -1);
            }
            else if (g.Mode == MineMode.Asym)
            {
                var opponent = g.Participants.First(x => x.ConnectionId != connectionId);
                opponent.IsSpectating = false; // на случай сдачи в фазе расстановки
                FinishWithWinner(room, opponent);
            }
            else
            {
                CheckWinByElimination(room);
                if (!g.IsFinished && g.TurnId == connectionId) AdvanceTurn(room);
            }
            room.Touch();
            return true;
        }
    }

    // ------------------------------------------------------------- таймеры

    /// <summary>
    /// Проверить дедлайн хода. Вызывается таймером хаба раз в секунду.
    /// Возвращает true, если состояние изменилось (нужен broadcast).
    /// </summary>
    public bool Tick(Room room)
    {
        lock (room.Sync)
        {
            var g = room.Mine;
            if (g == null || !g.IsStarted || g.IsFinished || g.TurnDeadline == null) return false;
            if (DateTime.UtcNow < g.TurnDeadline) return false;

            if (g.IsPlacing)
            {
                // время расстановки вышло — добираем мины и стартуем сапёра
                FinishPlacing(room, null, auto: true);
                return true;
            }

            var current = g.Find(g.TurnId);
            if (current != null)
            {
                if (g.Mode == MineMode.Pvp)
                {
                    // штраф за просрочку и переход хода
                    current.Score = Math.Max(0, current.Score - PvpTimeoutPenalty);
                    AdvanceTurn(room);
                }
                else if (g.Mode == MineMode.Cinema)
                {
                    // в кинотеатре просрочка = выбывание
                    current.IsOut = true;
                    CheckWinByElimination(room);
                    if (!g.IsFinished) AdvanceTurn(room);
                }
            }
            return true;
        }
    }

    /// <summary>Передать ход следующему играющему по кругу.</summary>
    private void AdvanceTurn(Room room)
    {
        var g = room.Mine!;
        var alive = g.Participants.Where(p => !p.IsOut && !p.IsSpectating).ToList();
        if (alive.Count == 0) { FinishDraw(room); return; }

        var idx = g.Participants.FindIndex(p => p.ConnectionId == g.TurnId);
        for (var step = 1; step <= g.Participants.Count; step++)
        {
            var next = g.Participants[(idx + step + g.Participants.Count) % g.Participants.Count];
            if (!next.IsOut && !next.IsSpectating)
            {
                g.TurnId = next.ConnectionId;
                g.TurnDeadline = DateTime.UtcNow.AddSeconds(TurnSeconds(g));
                return;
            }
        }
        FinishDraw(room);
    }

    /// <summary>
    /// Если остался один играющий — он победил; если не осталось — ничья.
    /// Террористы-наблюдатели (IsSpectating) в подсчёте не участвуют.
    /// </summary>
    private void CheckWinByElimination(Room room)
    {
        var g = room.Mine!;
        var alive = g.Participants.Where(p => !p.IsOut && !p.IsSpectating).ToList();
        if (alive.Count == 1) FinishWithWinner(room, alive[0]);
        else if (alive.Count == 0) FinishDraw(room);
    }

    // ------------------------------------------------------------- финалы

    private void FinishSolo(Room room, bool won, int exploded)
    {
        var g = room.Mine!;
        g.IsFinished = true;
        g.ExplodedIndex = exploded;
        g.FinishedAt = DateTime.UtcNow;
        g.ElapsedSeconds = (int)(g.FinishedAt - g.StartedAt).TotalSeconds;
        g.TurnDeadline = null;
        g.IsDraw = false;

        var p = g.Participants.FirstOrDefault();
        if (p == null) return;

        if (won) { g.WinnerId = p.ConnectionId; g.WinnerName = p.Name; }
        _records.Record(p.Name, g.Difficulty.Key, p.Score, g.ElapsedSeconds, won);
        _leaderboard.AddResult(p.Name, won ? "win" : "loss");
    }

    private void FinishWithWinner(Room room, MinePlayerState winner)
    {
        var g = room.Mine!;
        g.IsFinished = true;
        g.FinishedAt = DateTime.UtcNow;
        g.ElapsedSeconds = (int)(g.FinishedAt - g.StartedAt).TotalSeconds;
        g.TurnDeadline = null;
        g.IsDraw = false;
        g.WinnerId = winner.ConnectionId;
        g.WinnerName = winner.Name;

        // банк минус комиссия 5% — победителю
        var bank = g.Bank;
        if (bank > 0)
        {
            g.WinnerPayout = (int)Math.Floor(bank * (1 - HouseFee));
            _wallets.Add(winner.Name, g.WinnerPayout);
        }

        // ставки наблюдателей: пул делится между угадавшими пропорционально,
        // минус комиссия хаба 5% (проигравшие ставки уходят в пул)
        var winners = room.Bets.Where(b => b.Side == winner.ConnectionId).ToList();
        if (winners.Count > 0)
        {
            var pool = room.Bets.Sum(b => b.Amount);
            var winnersSum = winners.Sum(b => b.Amount);
            foreach (var bet in winners)
            {
                var share = (int)Math.Floor(pool * (1 - HouseFee) * bet.Amount / winnersSum);
                if (share > 0) _wallets.Add(bet.Name, share);
            }
        }
        room.Bets.Clear();

        _leaderboard.AddResult(winner.Name, "win");
        foreach (var p in g.Participants.Where(p => p.ConnectionId != winner.ConnectionId))
            _leaderboard.AddResult(p.Name, "loss");
    }

    /// <summary>
    /// Поле разминировано целиком: победитель — игрок с наибольшим счётом.
    /// В кинотеатре сравниваются только выжившие (выбывшие очков не делят).
    /// </summary>
    private void FinishByScore(Room room)
    {
        var g = room.Mine!;
        var pool = g.Mode == MineMode.Cinema
            ? g.Participants.Where(p => !p.IsOut && !p.IsSpectating).ToList()
            : g.Participants.Where(p => !p.IsSpectating).ToList();

        if (pool.Count == 0) { FinishDraw(room); return; }
        if (pool.Count == 1) { FinishWithWinner(room, pool[0]); return; }

        var best = pool.OrderByDescending(p => p.Score).ToList();
        if (best[0].Score == best[1].Score) FinishDraw(room);
        else FinishWithWinner(room, best[0]);
    }

    private void FinishDraw(Room room)
    {
        var g = room.Mine!;
        g.IsFinished = true;
        g.IsDraw = true;
        g.FinishedAt = DateTime.UtcNow;
        g.ElapsedSeconds = (int)(g.FinishedAt - g.StartedAt).TotalSeconds;
        g.TurnDeadline = null;

        // ante и ставки возвращаются
        foreach (var p in g.Participants)
            if (p.Ante > 0) _wallets.Add(p.Name, p.Ante);
        foreach (var bet in room.Bets)
            _wallets.Add(bet.Name, bet.Amount);
        room.Bets.Clear();

        foreach (var p in g.Participants)
            _leaderboard.AddResult(p.Name, "draw");
    }

    /// <summary>Новая партия: возврат несожжённых ante не нужен — они уже рассчитаны.</summary>
    public void Restart(Room room)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            g.RoundNumber++;
            g.IsStarted = false;
            g.IsFinished = false;
            g.IsPlacing = false;
            g.IsDraw = false;
            g.WinnerId = "";
            g.WinnerName = "";
            g.WinnerPayout = 0;
            g.ExplodedIndex = -1;
            g.AsymClicks = 0;
            g.TerroristPayout = 0;
            g.SapperPayout = 0;
            g.TurnId = "";
            g.TurnDeadline = null;
            // одиночка: место снова держится за хостом первые 10 секунд
            g.HostSeatReservedUntil = g.Mode == MineMode.Solo
                ? DateTime.UtcNow.AddSeconds(SoloHostSeatSeconds)
                : null;
            g.InitField();
            foreach (var p in g.Participants)
            {
                p.Score = 0;
                p.Ante = 0;
                p.IsOut = false;
                p.IsSpectating = false;
                p.IsReady = false;
            }
            room.Bets.Clear();
            room.Touch();
        }
    }

    // -------------------------------------------------------------- ставки

    /// <summary>Ставка наблюдателя на игрока (side = ConnectionId игрока).</summary>
    public string PlaceBet(Room room, Player player, string targetId, int amount, out int newBalance)
    {
        newBalance = _wallets.GetBalance(player.Name);
        lock (room.Sync)
        {
            var g = room.Mine!;
            if (g.Mode == MineMode.Solo) return "В одиночном режиме ставок нет.";
            if (g.IsStarted || g.IsFinished) return "Ставки принимаются только до начала партии.";
            if (amount < MinAnte) return $"Минимальная ставка — {MinAnte} монет.";
            if (g.Find(targetId) == null) return "Такого игрока нет в партии.";
            if (room.Bets.Any(b => b.ConnectionId == player.ConnectionId))
                return "Вы уже сделали ставку в этой партии.";
            if (g.Find(player.ConnectionId) != null)
                return "Игроки не ставят на себя — ставка уже внесена как ante.";
            if (!_wallets.TryWithdraw(player.Name, amount))
                return "Недостаточно денег на балансе.";

            room.Bets.Add(new Bet
            {
                ConnectionId = player.ConnectionId,
                Name = player.Name,
                Side = targetId,
                Amount = amount
            });
            room.Touch();
        }
        newBalance = _wallets.GetBalance(player.Name);
        return "ok";
    }

    /// <summary>
    /// Удаление комнаты: если партия шла — всем играющим засчитывается поражение
    /// (рекорды/лидерборд), банк не выплачивается. Несыгранные ante/ставки возвращаются.
    /// </summary>
    public void RefundRoom(Room room)
    {
        if (room.GameType != "minesweeper") return;
        lock (room.Sync)
        {
            var g = room.Mine!;

            // партия шла — всем участникам поражение, банк сгорает
            if (g.IsStarted && !g.IsFinished)
            {
                foreach (var p in g.Participants.Where(p => !p.IsOut && !p.IsSpectating))
                {
                    if (g.Mode == MineMode.Solo)
                    {
                        _records.Record(p.Name, g.Difficulty.Key, p.Score, 0, won: false);
                    }
                    _leaderboard.AddResult(p.Name, "loss");
                }
                g.IsFinished = true;
                g.TurnDeadline = null;
                room.Bets.Clear();
                return;
            }

            // после окончания партии банк уже рассчитан — возвращать нечего
            if (g.IsFinished) { room.Bets.Clear(); return; }

            foreach (var p in g.Participants)
                if (p.Ante > 0) _wallets.Add(p.Name, p.Ante);
            foreach (var bet in room.Bets)
                _wallets.Add(bet.Name, bet.Amount);
            room.Bets.Clear();
        }
    }

    // ---------------------------------------------------------- генерация

    /// <summary>Разложить мины, исключая первый клик и его соседей.</summary>
    private void GenerateMines(MineGameState g, int safeIndex)
    {
        var n = g.Difficulty.Cells;
        var excluded = new HashSet<int> { safeIndex };
        foreach (var nb in Neighbors(g, safeIndex)) excluded.Add(nb);

        var candidates = Enumerable.Range(0, n).Where(i => !excluded.Contains(i)).ToList();
        var count = Math.Min(g.MineCount, candidates.Count);
        for (var k = 0; k < count; k++)
        {
            var pick = _rng.Next(candidates.Count);
            g.Mines[candidates[pick]] = true;
            candidates.RemoveAt(pick);
        }
        RecalcNumbers(g);
        g.MinesPlaced = true;
    }

    private static void RecalcNumbers(MineGameState g)
    {
        for (var i = 0; i < g.Difficulty.Cells; i++)
            g.Numbers[i] = g.Mines[i] ? 0 : Neighbors(g, i).Count(nb => g.Mines[nb]);
    }

    private static IEnumerable<int> Neighbors(MineGameState g, int index)
    {
        var x = index % g.Width;
        var y = index / g.Width;
        for (var dy = -1; dy <= 1; dy++)
            for (var dx = -1; dx <= 1; dx++)
            {
                if (dx == 0 && dy == 0) continue;
                var nx = x + dx;
                var ny = y + dy;
                if (nx >= 0 && nx < g.Width && ny >= 0 && ny < g.Height)
                    yield return ny * g.Width + nx;
            }
    }

    /// <summary>Каскадное открытие: нули раскрывают соседей. Возвращает очки.</summary>
    private static (int points, int count) FloodOpen(MineGameState g, int start)
    {
        var points = 0;
        var count = 0;
        var queue = new Queue<int>();
        queue.Enqueue(start);

        while (queue.Count > 0)
        {
            var i = queue.Dequeue();
            if (g.Opened[i] || g.Mines[i]) continue;
            g.Opened[i] = true;
            g.Flagged[i] = false;
            count++;
            // пустая клетка (0) — 1 очко, число N — N очков
            points += g.Numbers[i] == 0 ? 1 : g.Numbers[i];

            if (g.Numbers[i] == 0)
                foreach (var nb in Neighbors(g, i))
                    if (!g.Opened[nb] && !g.Mines[nb]) queue.Enqueue(nb);
        }
        return (points, count);
    }

    // ------------------------------------------------------------- снимки

    /// <summary>Снимок для конкретного клиента: мины скрыты до конца партии.</summary>
    public MineSnapshot GetSnapshot(Room room, string connectionId, Func<string, string> getName,
        IEnumerable<Player> allPlayers)
    {
        lock (room.Sync)
        {
            var g = room.Mine!;
            var cells = new int[g.Difficulty.Cells];
            var revealMines = g.IsFinished;

            for (var i = 0; i < cells.Length; i++)
            {
                if (g.Opened[i])
                    cells[i] = g.Mines[i] ? -3 : g.Numbers[i];
                else if (g.Flagged[i])
                    cells[i] = -2;
                else if (revealMines && g.Mines[i])
                    cells[i] = -3;
                else
                    cells[i] = -1;
            }

            // террорист во время расстановки видит свои мины
            var me = g.Find(connectionId);
            if (g.IsPlacing && me is { IsTerrorist: true })
                for (var i = 0; i < cells.Length; i++)
                    if (g.Mines[i] && !g.Opened[i]) cells[i] = -3;

            int? secondsLeft = g.TurnDeadline == null
                ? null
                : Math.Max(0, (int)Math.Ceiling((g.TurnDeadline.Value - DateTime.UtcNow).TotalSeconds));

            var elapsed = g.IsStarted
                ? (int)(((g.IsFinished ? g.FinishedAt : DateTime.UtcNow) - g.StartedAt).TotalSeconds)
                : 0;

            var members = allPlayers.Where(p => p.CurrentRoomId == room.Id).OrderBy(p => p.JoinedAt).ToList();
            var participantIds = g.Participants.Select(p => p.ConnectionId).ToHashSet();

            var player = allPlayers.FirstOrDefault(p => p.ConnectionId == connectionId);

            return new MineSnapshot
            {
                RoomId = room.Id,
                RoomName = room.Name,
                HostConnectionId = room.HostConnectionId,
                IsHost = room.HostConnectionId == connectionId,
                HasPassword = room.Password != "",
                Mode = g.Mode,
                DifficultyKey = g.Difficulty.Key,
                DifficultyTitle = g.Difficulty.Title,
                Width = g.Width,
                Height = g.Height,
                MineCount = g.MineCount,
                Ante = g.Ante,
                Cells = cells,
                MineIndexes = revealMines
                    ? Enumerable.Range(0, cells.Length).Where(i => g.Mines[i]).ToArray()
                    : Array.Empty<int>(),
                IsStarted = g.IsStarted,
                IsFinished = g.IsFinished,
                IsPlacing = g.IsPlacing,
                TurnId = g.TurnId,
                TurnName = getName(g.TurnId),
                TurnSecondsLeft = secondsLeft,
                ElapsedSeconds = elapsed,
                ExplodedIndex = g.ExplodedIndex,
                WinnerId = g.WinnerId,
                WinnerName = g.WinnerName,
                IsDraw = g.IsDraw,
                WinnerPayout = g.WinnerPayout,
                Bank = g.Bank,
                FlagsLeft = g.MineCount - g.Flagged.Count(f => f),
                MinesPlacedByTerrorist = g.Mines.Count(m => m),
                AsymClicks = g.AsymClicks,
                CashOutPayout = g.Mode == MineMode.Asym && g.IsStarted && !g.IsFinished && !g.IsPlacing
                    ? CashOutShare(g)
                    : 0,
                TerroristPayout = g.TerroristPayout,
                HostSeatSecondsLeft = g.HostSeatReservedUntil is { } until && DateTime.UtcNow < until
                    ? (int)Math.Ceiling((until - DateTime.UtcNow).TotalSeconds)
                    : 0,
                PlayersNeeded = g.IsStarted ? 0 : Math.Max(0, MinPlayers(g.Mode) - g.Participants.Count),
                MyRecord = g.Mode == MineMode.Solo && player != null
                    ? _records.Get(player.Name, g.Difficulty.Key)
                    : null,
                Participants = g.Participants.Select(p => new MineParticipantDto
                {
                    ConnectionId = p.ConnectionId,
                    Name = p.Name,
                    Score = p.Score,
                    Ante = p.Ante,
                    IsOut = p.IsOut,
                    IsSpectating = p.IsSpectating,
                    IsTerrorist = p.IsTerrorist,
                    IsReady = p.IsReady
                }).ToList(),
                Spectators = members.Where(p => !participantIds.Contains(p.ConnectionId)).Select(p => new PlayerDto
                {
                    ConnectionId = p.ConnectionId,
                    Name = p.Name,
                    Side = "",
                    IsReady = false,
                    IsModerator = p.IsModerator
                }).ToList(),
                Bets = room.Bets.Select(b => new BetDto
                {
                    Name = b.Name,
                    Side = getName(b.Side),
                    Amount = b.Amount
                }).ToList(),
                BettingOpen = g.Mode != MineMode.Solo && !g.IsStarted && !g.IsFinished
            };
        }
    }

    public List<MineRecordDto> GetRecordsTop() => _records.GetTop();
}