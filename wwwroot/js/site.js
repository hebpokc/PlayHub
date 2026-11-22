"use strict";

// ------------------------------------------------------------ элементы DOM
const $ = (id) => document.getElementById(id);

const screens = { join: $("screen-join"), lobby: $("screen-lobby"), room: $("screen-room"), mine: $("screen-mine") };
const joinForm = $("join-form");
const nameInput = $("name-input");
const joinStatus = $("join-status");
const modToggle = $("mod-toggle");
const modForm = $("mod-form");
const toast = $("toast");
const banner = $("banner");
const cells = Array.from(document.querySelectorAll("#board .cell"));

const chatList = $("chat-list");
const chatForm = $("chat-form");
const chatInput = $("chat-input");

// ------------------------------------------------------------- наше состояние
let connection = null;
let myId = "";
let myName = "";
let mySide = "";
let myBalance = 0;
let isModerator = false;
let lobbyState = null;      // последний снимок лобби
let roomState = null;       // последний снимок комнаты
let mineState = null;       // последний снимок сапёра
let lastBoard = [];
let toastTimer = null;

function showScreen(name) {
    Object.keys(screens).forEach((k) => screens[k].classList.toggle("active", k === name));
}

function showToast(text, kind) {
    toast.textContent = text;
    toast.className = "toast show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.className = "toast"), 3200);
}

// ============================================================ подключение

async function startConnection() {
    connection = new signalR.HubConnectionBuilder()
        .withUrl("/hubs/game")
        .withAutomaticReconnect()
        .configureLogging(signalR.LogLevel.Warning)
        .build();

    registerHandlers();
    await connection.start();
}

async function joinAs(name, moderatorPassword) {
    joinStatus.className = "status";
    joinStatus.textContent = "Подключение к серверу…";
    $("join-button").disabled = true;
    $("mod-join-button").disabled = true;

    try {
        await startConnection();
        await connection.invoke("Join", name, moderatorPassword);
    } catch (err) {
        joinStatus.className = "status error";
        joinStatus.textContent = "Сервер не отвечает. Запустите проект в Visual Studio (F5).";
        $("join-button").disabled = false;
        $("mod-join-button").disabled = false;
        console.error(err);
    }
}

joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    myName = nameInput.value.trim() || "Гость";
    joinAs(myName, null);
});

modToggle.addEventListener("click", () => {
    const open = modForm.hidden;
    modForm.hidden = !open;
    modToggle.textContent = open ? "✕ Отмена" : "🛡 Войти как модератор";
    if (open) $("mod-name-input").focus();
});

modForm.addEventListener("submit", (e) => {
    e.preventDefault();
    myName = $("mod-name-input").value.trim() || "Гость";
    const pass = $("mod-pass-input").value;
    if (!pass) return;
    isModerator = true;
    joinAs(myName, pass);
});

function registerHandlers() {
    // сервер присылает наши данные после входа
    connection.on("Welcome", (info) => {
        myId = info.connectionId;
        myName = info.name;
        myBalance = info.balance;
        isModerator = !!info.isModerator;
        $("join-button").disabled = false;
        $("mod-join-button").disabled = false;
        renderBalance();
        showScreen("lobby");
    });

    connection.on("Banned", () => {
        joinStatus.className = "status error";
        joinStatus.textContent = "Вы забанены на этом сайте и не можете войти.";
        $("join-button").disabled = false;
        $("mod-join-button").disabled = false;
    });

    // лобби: комнаты + пользователи + лидеры
    connection.on("LobbyUpdated", (snapshot) => {
        lobbyState = snapshot;
        renderLobby(snapshot);
    });

    // комната: состояние партии
    connection.on("RoomUpdated", (snapshot) => {
        if (!snapshot) return;
        roomState = snapshot;
        mineState = null;
        mineFieldKey = "";
        // успешный вход в закрытую комнату — закрываем модалку пароля
        pendingRoomId = "";
        $("room-password-error").hidden = true;
        $("room-password-modal").className = "banner";
        showScreen("room");
        renderRoom(snapshot);
    });

    connection.on("RoomLeft", () => {
        roomState = null;
        mineState = null;
        mineFieldKey = "";
        showScreen("lobby");
    });

    connection.on("RoomDeleted", (message) => {
        roomState = null;
        mineState = null;
        mineFieldKey = "";
        showScreen("lobby");
        showToast(message, "error");
    });

    // комната требует пароль — показываем модалку
    connection.on("RoomPasswordRequired", (info) => {
        const wrongAttempt = pendingRoomId === info.roomId;
        pendingRoomId = info.roomId;
        $("room-password-text").textContent = `Комната «${info.roomName}» закрыта паролем. Введите его, чтобы войти.`;
        $("room-password-error").hidden = !wrongAttempt;
        $("room-enter-password-input").value = "";
        $("room-password-modal").className = "banner show";
        if (wrongAttempt) {
            const card = $("room-password-modal").querySelector(".banner-card");
            card.classList.remove("shake");
            void card.offsetWidth;
            card.classList.add("shake");
        }
        $("room-enter-password-input").focus();
    });

    connection.on("BalanceUpdated", (balance) => {
        myBalance = balance;
        renderBalance();
    });

    // ------------------------------------------------------- сапёр
    connection.on("MineRoomUpdated", (snapshot) => {
        if (!snapshot) return;
        mineState = snapshot;
        roomState = null;
        pendingRoomId = "";
        $("room-password-error").hidden = true;
        $("room-password-modal").className = "banner";
        showScreen("mine");
        renderMine(snapshot);
    });

    connection.on("MineMatchStarted", () => showToast("Сапёр: партия началась! 💣", "ok"));
    connection.on("MineGameRestarted", () => showToast("Новая партия — внесите ставку и нажмите «Готов»."));

    connection.on("MineExploded", (info) => {
        showToast(`💥 ${info.name} подорвался на мине!`, "error");
        const cell = document.querySelector(`#mine-field .mcell[data-index="${info.index}"]`);
        if (cell) {
            cell.classList.add("boom");
            setTimeout(() => cell.classList.remove("boom"), 700);
        }
    });

    connection.on("MinePoints", (info) => {
        // всплывающие очки над полем
        const wrap = $("mine-field-wrap").getBoundingClientRect();
        const pop = document.createElement("div");
        pop.className = "mine-points-pop";
        pop.textContent = `+${info.points}`;
        pop.style.left = (wrap.left + wrap.width / 2 - 20) + "px";
        pop.style.top = (wrap.top + 40) + "px";
        document.body.appendChild(pop);
        setTimeout(() => pop.remove(), 1100);
    });

    connection.on("MineGameFinished", (result) => {
        const solo = mineState && mineState.mode === "solo";
        if (result.isDraw) {
            showBanner("Ничья!", "Сапёр: ничья — ставки возвращены.");
        } else if (result.winnerId === myId) {
            showBanner("Победа! 🎉", result.payout > 0
                ? `Вы получаете ${result.payout} монет из банка (комиссия хаба 5%).`
                : "Поле разминировано — рекорд записан!");
            confetti(220);
        } else if (result.winnerName) {
            showBanner(`${result.winnerName} победил!`, solo
                ? "Партия окончена — рекорд игрока записан в таблицу."
                : result.payout > 0
                    ? `Банк ${result.payout} монет уходит победителю. Реванш?`
                    : "Реванш?");
            confetti(70);
        } else {
            showBanner("Партия окончена", "Поле открыто — посмотрите, где были мины.");
        }
    });

    // чат: сначала история для новичка, потом каждое новое сообщение
    connection.on("ChatHistory", (messages) => renderChatHistory(messages || []));
    connection.on("ChatMessage", (message) => appendChatMessage(message));

    connection.on("UserJoined", (name) => showToast(`${name} зашёл на сайт`));
    connection.on("UserLeft", (name) => showToast(`${name} покинул сайт`));
    connection.on("MatchStarted", () => showToast("Матч начался! ✕ ходит первым", "ok"));
    connection.on("GameRestarted", () => showToast("Доска очищена. Нажмите «Готов»."));

    connection.on("Kicked", (message) => {
        showToast(message, "error");
        setTimeout(async () => {
            if (connection) await connection.stop();
            location.reload();
        }, 1500);
    });

    connection.on("ServerError", (message) => {
        showToast(message, "error");
        const active = document.querySelector(".screen.active");
        if (active) {
            active.classList.remove("shake");
            void active.offsetWidth;
            active.classList.add("shake");
        }
    });

    connection.on("GameFinished", (result) => {
        if (result.isDraw) {
            showBanner("Ничья!", "Друзья победили дружбу. Ставки возвращены.");
        } else {
            const iWon = result.winner === mySide;
            const title = iWon ? "Победа! 🎉" : `${result.winnerName} победил!`;
            const text = iWon
                ? `Награда за выигрыш: +${result.prize} монет. Результат записан в таблицу лидеров.`
                : `Счёт открыт для ${result.winnerName}. Реванш?`;
            showBanner(title, text);
            confetti(iWon ? 220 : 90);
        }
    });

    connection.onreconnecting(() => setConnection(false, "переподключение…"));
    connection.onreconnected(() => {
        setConnection(true, "онлайн");
        connection.invoke("Join", myName, isModerator ? "" : null);
    });
    connection.onclose(() => setConnection(false, "нет связи"));
}

function setConnection(ok, text) {
    $("conn-dot").className = "dot " + (ok ? "on" : "off");
    $("conn-text").textContent = text;
    $("room-conn-dot").className = "dot " + (ok ? "on" : "off");
    $("room-conn-text").textContent = text;
    $("mine-conn-dot").className = "dot " + (ok ? "on" : "off");
    $("mine-conn-text").textContent = text;
}

function renderBalance() {
    $("my-balance").textContent = `💰 ${myBalance}`;
    $("room-my-balance").textContent = `💰 ${myBalance}`;
    $("mine-my-balance").textContent = `💰 ${myBalance}`;
}

// ============================================================ действия: лобби

// ------------------------------------------------- меню создания комнаты
let createGame = "tictactoe";
let createMode = "solo";
let createDiff = "easy";

const modeDescriptions = {
    solo: "Один игрок, остальные смотрят. Цель — максимум очков до подрыва. Ставок нет.",
    pvp: "Двое ходят по очереди. Подорвался — проиграл. Быстрые ходы дают множитель очков. Банк из ставок игроков.",
    asym: "Террорист расставляет мины (60 сек), сапёр разминирует. Роли меняются каждую партию.",
    cinema: "3–8 игроков ходят по кругу (20 сек на ход). Подорвался — выбыл. Последний выживший забирает банк."
};

$("open-create-menu").addEventListener("click", () => {
    $("create-step-games").hidden = false;
    $("create-settings-form").hidden = true;
    $("create-menu").className = "banner show";
});

$("create-cancel").addEventListener("click", () => ($("create-menu").className = "banner"));

$("create-back").addEventListener("click", () => {
    $("create-step-games").hidden = false;
    $("create-settings-form").hidden = true;
});

document.querySelectorAll(".game-card[data-game]").forEach((card) => {
    // 3D-наклон с подсветкой, следующей за курсором
    card.addEventListener("mousemove", (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = `perspective(600px) rotateY(${px * 14}deg) rotateX(${-py * 14}deg) translateY(-3px)`;
    });
    card.addEventListener("mouseleave", () => (card.style.transform = ""));

    card.addEventListener("click", () => {
        createGame = card.dataset.game;
        $("create-step-games").hidden = true;
        $("create-settings-form").hidden = false;
        $("mine-settings").hidden = createGame !== "minesweeper";
        $("create-game-title").textContent = createGame === "minesweeper"
            ? "💣 Сапёр — настройки партии"
            : "🎮 Крестики-нолики — настройки комнаты";
        $("create-room-name").focus();
    });
});

document.querySelectorAll("#mine-mode-options .option").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("#mine-mode-options .option").forEach((b) => b.classList.toggle("active", b === btn));
        createMode = btn.dataset.mode;
        $("mine-mode-desc").textContent = modeDescriptions[createMode];
    });
});

document.querySelectorAll("#mine-diff-options .option").forEach((btn) => {
    btn.addEventListener("click", () => {
        document.querySelectorAll("#mine-diff-options .option").forEach((b) => b.classList.toggle("active", b === btn));
        createDiff = btn.dataset.diff;
    });
});

$("create-settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!connection) return;
    const name = $("create-room-name").value.trim();
    const password = $("create-room-password").value;
    try {
        if (createGame === "minesweeper")
            await connection.invoke("CreateMineRoom", name, password, createMode, createDiff, 10);
        else
            await connection.invoke("CreateRoom", name, password);
        $("create-room-name").value = "";
        $("create-room-password").value = "";
        $("create-menu").className = "banner";
        // экран переключится по RoomUpdated / MineRoomUpdated
    } catch (err) { console.error(err); }
});

// --------------------------------------------------------- вкладки таблиц
document.querySelectorAll("#tables-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelectorAll("#tables-tabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
        document.querySelectorAll(".tab-page").forEach((p) => {
            const active = p.id === tab.dataset.tab;
            p.hidden = !active;
            p.classList.toggle("active", active);
        });
    });
});

// ------------------------------------------------------------ пароль комнаты
let pendingRoomId = "";

$("room-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!connection || !pendingRoomId) return;
    const password = $("room-enter-password-input").value;
    try {
        await connection.invoke("JoinRoom", pendingRoomId, password);
    } catch (err) { console.error(err); }
});

$("room-password-cancel").addEventListener("click", () => {
    pendingRoomId = "";
    $("room-password-error").hidden = true;
    $("room-password-modal").className = "banner";
});

$("unban-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!connection) return;
    const name = $("unban-input").value.trim();
    if (!name) return;
    try {
        await connection.invoke("UnbanUser", name);
        $("unban-input").value = "";
    } catch (err) { console.error(err); }
});

$("leave-button").addEventListener("click", async () => {
    if (connection) await connection.stop();
    location.reload();
});

// ============================================================ действия: комната

$("exit-room-button").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("LeaveRoom"); } catch (err) { console.error(err); }
});

$("delete-room-button").addEventListener("click", async () => {
    if (!connection) return;
    if (!confirm("Удалить эту комнату? Все участники вернутся в лобби.")) return;
    try { await connection.invoke("DeleteRoom", null); } catch (err) { console.error(err); }
});

document.querySelectorAll(".role").forEach((btn) => {
    btn.addEventListener("click", async () => {
        const side = btn.dataset.side;
        if (!connection) return;
        try {
            await connection.invoke("ChooseSide", side);
            mySide = side;
        } catch (err) { console.error(err); }
    });
});

$("ready-button").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("SetReady", true); } catch (err) { console.error(err); }
});

$("restart-button").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("Restart"); } catch (err) { console.error(err); }
});

// ставки наблюдателей
async function placeBet(side) {
    if (!connection) return;
    const amount = Number($("bet-amount").value);
    if (!Number.isInteger(amount) || amount <= 0) {
        showToast("Введите сумму ставки — целое число больше нуля.", "error");
        return;
    }
    try { await connection.invoke("PlaceBet", side, amount); } catch (err) { console.error(err); }
}
$("bet-x").addEventListener("click", () => placeBet("X"));
$("bet-o").addEventListener("click", () => placeBet("O"));

cells.forEach((cell) => {
    cell.addEventListener("click", async () => {
        if (!connection || cell.disabled) return;
        const index = Number(cell.dataset.index);
        try { await connection.invoke("MakeMove", index); } catch (err) { console.error(err); }
    });
});

// модерация: кик и бан прямо в списке пользователей
async function kickUser(connectionId) {
    try { await connection.invoke("KickUser", connectionId); } catch (err) { console.error(err); }
}

async function banUser(connectionId) {
    try { await connection.invoke("BanUser", connectionId); } catch (err) { console.error(err); }
}

$("banner-close").addEventListener("click", () => (banner.className = "banner"));

// ============================================================ отрисовка: лобби

function mineModeLabel(mode) {
    return { solo: "Одиночка", pvp: "PvP", asym: "Сапёр vs Террорист", cinema: "Кинотеатр" }[mode] || mode;
}

function mineDiffLabel(diff) {
    return { easy: "лёгкая", medium: "средняя", hard: "тяжёлая" }[diff] || diff;
}

function renderLobby(s) {
    setConnection(true, "онлайн");
    $("online-count").textContent = s.users.length;
    $("users-count").textContent = s.users.length;
    $("my-name").textContent = myName + (isModerator ? " 🛡" : "");
    $("mod-panel").hidden = !isModerator;

    renderRooms(s.rooms || []);
    renderUsers(s.users || []);
    renderLeaders(s.leaderboard || []);

    // таблицы видны всем пользователям
    renderModStats();
    renderBalances();
    renderMineRecords();

    if (isModerator) renderBanned();
}

function renderRooms(rooms) {
    const list = $("rooms-list");
    list.innerHTML = "";

    if (!rooms.length) {
        const li = document.createElement("li");
        li.className = "empty-row";
        li.textContent = "Комнат нет — создайте первую!";
        list.appendChild(li);
        return;
    }

    rooms.forEach((r) => {
        const li = document.createElement("li");
        li.className = "room-item";

        const isMine = r.gameType === "minesweeper";
        const tag = isMine
            ? `<span class="game-tag">💣 ${mineModeLabel(r.mineMode)} · ${mineDiffLabel(r.mineDifficulty)}</span>`
            : `<span class="game-tag">✕◯</span>`;

        const info = document.createElement("div");
        info.className = "room-info";
        info.innerHTML =
            `<div class="room-name">${r.hasPassword ? "🔒 " : ""}${escapeHtml(r.name)} ${tag} ${r.inGame ? '<span class="live">идёт игра</span>' : ""}</div>` +
            `<div class="room-sub">хост: ${escapeHtml(r.hostName)} · 🎮: ${r.playersCount} · 👁: ${r.spectatorsCount}` +
            (isMine
                ? (r.mineBank > 0 ? ` · банк: ${r.mineBank}💰` : "")
                : (r.potX + r.potO > 0 ? ` · банк ставок: ${r.potX + r.potO}💰` : "")) + `</div>`;

        const join = document.createElement("button");
        join.className = "btn primary small";
        join.textContent = r.hasPassword ? "🔒 Войти" : "Войти";
        join.addEventListener("click", async () => {
            try {
                await connection.invoke("JoinRoom", r.id, null);
            } catch (err) { console.error(err); }
        });

        li.appendChild(info);
        li.appendChild(join);

        // хост комнаты и модератор могут удалить её прямо из лобби
        if (r.hostConnectionId === myId || isModerator) {
            const del = document.createElement("button");
            del.className = "btn tiny danger";
            del.textContent = "🗑";
            del.title = "Удалить комнату";
            del.addEventListener("click", async () => {
                if (!confirm(`Удалить комнату «${r.name}»?`)) return;
                try { await connection.invoke("DeleteRoom", r.id); } catch (err) { console.error(err); }
            });
            li.appendChild(del);
        }

        list.appendChild(li);
    });
}

function renderUsers(users) {
    const list = $("users-list");
    list.innerHTML = "";

    users.forEach((p) => {
        const li = document.createElement("li");

        const name = document.createElement("span");
        name.textContent = p.isModerator ? `🛡 ${p.name}` : p.name;

        li.appendChild(name);

        if (p.connectionId === myId) {
            const me = document.createElement("span");
            me.className = "who";
            me.textContent = "это вы";
            li.appendChild(me);
        } else if (isModerator) {
            const kick = document.createElement("button");
            kick.className = "btn tiny danger";
            kick.textContent = "кик";
            kick.addEventListener("click", () => kickUser(p.connectionId));

            const ban = document.createElement("button");
            ban.className = "btn tiny danger";
            ban.textContent = "бан";
            ban.addEventListener("click", () => banUser(p.connectionId));

            li.appendChild(kick);
            li.appendChild(ban);
        }

        list.appendChild(li);
    });
}

async function renderBanned() {
    const list = $("banned-list");
    try {
        const banned = await connection.invoke("GetBannedList");
        list.innerHTML = "";
        if (!banned.length) {
            const li = document.createElement("li");
            li.className = "empty-row";
            li.textContent = "забаненных нет";
            list.appendChild(li);
            return;
        }
        banned.forEach((name) => {
            const li = document.createElement("li");
            li.textContent = `⛔ ${name}`;
            list.appendChild(li);
        });
    } catch (err) { console.error(err); }
}

function renderLeaders(rows) {
    const body = $("leaders-body");
    body.innerHTML = "";
    if (!rows.length) {
        body.innerHTML = `<tr><td colspan="5" class="empty">Пока пусто — сыграйте партию!</td></tr>`;
        return;
    }
    rows.slice(0, 10).forEach((r, i) => {
        const tr = document.createElement("tr");
        if (i === 0) tr.className = "top1";
        if (r.name.toLowerCase() === myName.toLowerCase()) tr.className += " me";
        tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${r.wins}</td>` +
            `<td>${r.games}</td><td>${r.score}</td>`;
        body.appendChild(tr);
    });
}

// --------------------------------------------------- таблицы модератора

/** Работник месяца: модератор с наибольшей суммой банов и киков. */
async function renderModStats() {
    const body = $("mod-stats-body");
    const headline = $("employee-of-month");
    try {
        const stats = await connection.invoke("GetModeratorStats");
        body.innerHTML = "";
        if (!stats.length || stats[0].total === 0) {
            headline.textContent = "Пока нет действий модерации.";
            body.innerHTML = `<tr><td colspan="5" class="empty">Статистики пока нет.</td></tr>`;
            return;
        }
        const best = stats[0];
        headline.innerHTML = `🏆 <b>${escapeHtml(best.name)}</b> — ${best.bans} бан(ов), ${best.kicks} кик(ов), всего ${best.total} действий.`;
        stats.forEach((s, i) => {
            const tr = document.createElement("tr");
            if (i === 0) tr.className = "top1";
            if (s.name.toLowerCase() === myName.toLowerCase()) tr.className += " me";
            tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(s.name)}</td><td>${s.bans}</td>` +
                `<td>${s.kicks}</td><td>${s.total}</td>`;
            body.appendChild(tr);
        });
    } catch (err) { console.error(err); }
}

/** Таблица балансов всех пользователей. */
async function renderBalances() {
    const body = $("balances-body");
    try {
        const balances = await connection.invoke("GetBalances");
        body.innerHTML = "";
        if (!balances.length) {
            body.innerHTML = `<tr><td colspan="3" class="empty">Пока пусто.</td></tr>`;
            return;
        }
        balances.forEach((b, i) => {
            const tr = document.createElement("tr");
            if (i === 0) tr.className = "top1";
            if (b.name.toLowerCase() === myName.toLowerCase()) tr.className += " me";
            tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(b.name)}</td><td>💰 ${b.balance}</td>`;
            body.appendChild(tr);
        });
    } catch (err) { console.error(err); }
}

/** Таблица рекордов сапёра (видна всем). */
async function renderMineRecords() {
    const body = $("mine-records-body");
    try {
        const rows = await connection.invoke("GetMineRecords");
        body.innerHTML = "";
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="5" class="empty">Рекордов пока нет.</td></tr>`;
            return;
        }
        rows.slice(0, 10).forEach((r, i) => {
            const tr = document.createElement("tr");
            if (i === 0) tr.className = "top1";
            if (r.name.toLowerCase() === myName.toLowerCase()) tr.className += " me";
            const time = r.bestTimeSeconds > 0 ? formatTime(r.bestTimeSeconds) : "—";
            tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${mineDiffLabel(r.difficulty)}</td>` +
                `<td>${r.bestScore}</td><td>${time}</td>`;
            body.appendChild(tr);
        });
    } catch (err) { console.error(err); }
}

function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

// ============================================================ отрисовка: сапёр

let mineFieldKey = "";      // размер поля, чтобы не пересоздавать DOM каждый кадр
let mineTurnDeadlineAt = 0; // локальный дедлайн хода (мс) — тикаем между снимками
let mineHostSeatAt = 0;     // локальный дедлайн резерва места хоста (мс)

// локальный тик таймеров сапёра: сервер шлёт снимки только при изменениях,
// поэтому секунды хода/расстановки и резерв хоста убываем сами
setInterval(() => {
    const s = mineState;
    if (!s || s.isFinished) return;

    if (s.isStarted && !s.isFinished && s.turnSecondsLeft != null && mineTurnDeadlineAt > 0) {
        const sec = Math.max(0, Math.ceil((mineTurnDeadlineAt - Date.now()) / 1000));
        const chip = $("mine-turn-seconds");
        chip.textContent = `· ${sec}с`;
        chip.className = sec <= 5 ? "urgent" : "";
    }

    if (!s.isStarted && s.hostSeatSecondsLeft > 0 && mineHostSeatAt > 0) {
        const left = Math.max(0, Math.ceil((mineHostSeatAt - Date.now()) / 1000));
        const join = $("mine-join-button");
        const seat = s.participants.some((p) => p.connectionId === myId);
        if (!seat && left > 0 && !s.isHost) {
            join.disabled = true;
            join.textContent = `⏳ Место хоста · ${left}с`;
        } else {
            join.disabled = false;
            join.textContent = "🎮 Сесть играть";
        }
    }

    // секундомер партии тикает локально (сервер обновляет только при ходах)
    if (s.isStarted && !s.isFinished) {
        $("mine-timer").textContent = formatTime(s.elapsedSeconds + Math.floor((Date.now() - mineSnapshotAt) / 1000));
    }
}, 500);

let mineSnapshotAt = Date.now();

function renderMine(s) {
    if (!s) return;

    mineSnapshotAt = Date.now();
    mineTurnDeadlineAt = s.turnSecondsLeft != null ? Date.now() + s.turnSecondsLeft * 1000 : 0;
    mineHostSeatAt = s.hostSeatSecondsLeft > 0 ? Date.now() + s.hostSeatSecondsLeft * 1000 : 0;

    $("mine-room-title").textContent = (s.hasPassword ? "🔒 " : "") + s.roomName;
    $("mine-my-name").textContent = myName + (isModerator ? " 🛡" : "");
    $("mine-delete-room").hidden = !(s.isHost || isModerator);
    setConnection(true, "онлайн");

    const me = s.participants.find((p) => p.connectionId === myId);
    const isPlayer = !!me && !me.isOut;
    const myTurn = s.isStarted && !s.isFinished && s.turnId === myId;
    const placing = s.isPlacing && myTurn;

    $("mine-mode-hint").textContent =
        `${mineModeLabel(s.mode)} · ${s.difficultyTitle} ${s.width}×${s.height} · ${s.mineCount} мин` +
        (s.mode !== "solo" ? ` · ante от ${s.ante}💰` : " · без ставок");

    // --- кнопки управления
    const seatTaken = !!me;
    const hostReserve = !s.isStarted && !seatTaken && !s.isHost && s.hostSeatSecondsLeft > 0;
    $("mine-join-button").hidden = seatTaken || (s.isStarted && !s.isFinished);
    $("mine-join-button").disabled = hostReserve;
    $("mine-join-button").textContent = hostReserve
        ? `⏳ Место хоста · ${s.hostSeatSecondsLeft}с`
        : "🎮 Сесть играть";
    $("mine-leave-button").hidden = !me || (s.isStarted && !s.isFinished);
    $("mine-ante-row").hidden = !me || s.mode === "solo" || s.isStarted || (me && me.ante > 0);
    $("mine-ready-button").hidden = !me || s.isStarted;
    $("mine-ready-button").disabled = !me || (me && me.isReady);
    $("mine-ready-button").textContent = me && me.isReady ? "Готово! Ждём остальных…" : "Готов / Начать";
    $("mine-ready-button").className = "btn big " + (me && me.isReady ? "ready" : "primary");
    $("mine-place-done").hidden = !placing;
    $("mine-surrender-button").hidden = !isPlayer || !s.isStarted || s.isFinished || s.isPlacing;
    $("mine-restart-button").hidden = !s.isFinished || !me;

    // --- статусная строка
    // при расстановке показываем, сколько мин осталось поставить террористу
    const placingPhase = s.isPlacing && !s.isFinished;
    $("mine-flags-left").textContent = placingPhase
        ? Math.max(0, s.mineCount - (s.minesPlacedByTerrorist || 0))
        : s.flagsLeft;
    $("mine-flags-label").textContent = placingPhase ? "Мин осталось:" : "💣 Мин:";
    $("mine-timer").textContent = formatTime(s.elapsedSeconds);
    $("mine-turn-chip").hidden = !s.isStarted || s.isFinished || s.mode === "solo";
    if (s.isStarted && !s.isFinished && s.mode !== "solo") {
        $("mine-turn-name").textContent = s.isPlacing ? `${s.turnName} (расстановка)` : s.turnName;
        const sec = s.turnSecondsLeft;
        $("mine-turn-seconds").textContent = sec == null ? "" : `· ${sec}с`;
        $("mine-turn-seconds").className = sec != null && sec <= 5 ? "urgent" : "";
    }

    // --- поле
    renderMineField(s, me, myTurn, placing);

    // --- подпись под полем
    const status = $("mine-status-text");
    if (s.isFinished) {
        status.innerHTML = s.isDraw
            ? "Ничья — ставки возвращены."
            : s.winnerName
                ? `Победа: <b>${escapeHtml(s.winnerName)}</b> 🎉` + (s.winnerPayout > 0 ? ` +${s.winnerPayout}💰` : "")
                : "Партия окончена.";
    } else if (!s.isStarted) {
        if (s.mode === "cinema" && s.playersNeeded > 0) {
            status.innerHTML = me
                ? `Ждём ещё <b>${s.playersNeeded}</b> игрок(а) для старта — затем все нажимают «Готов».`
                : `Кинотеатр: ждём ещё <b>${s.playersNeeded}</b> игрок(а). Сядьте играть, чтобы участвовать!`;
        } else if (me) {
            status.textContent = "Нажмите «Готов», чтобы начать партию.";
        } else {
            status.textContent = "Займите место игрока или наблюдайте за партией.";
        }
    } else if (s.isPlacing) {
        status.innerHTML = placing
            ? "Расставьте мины: <b>левый клик</b> — поставить/снять. Затем «Мины расставлены»."
            : `<b>${escapeHtml(s.turnName)}</b> расставляет мины…`;
    } else {
        status.innerHTML = s.mode === "solo"
            ? "Левый клик — открыть, правый — флажок. Первый ход безопасный."
            : myTurn
                ? "<b>Ваш ход!</b> Левый клик — открыть, правый — флажок."
                : `Ходит <b>${escapeHtml(s.turnName)}</b>…`;
    }

    // --- счёт под полем
    const scores = $("mine-scores");
    scores.innerHTML = "";
    s.participants.forEach((p) => {
        const card = document.createElement("div");
        card.className = "mine-score-card" +
            (p.connectionId === s.turnId && !s.isFinished ? " turn" : "") +
            (p.isOut ? " out" : "");
        const role = s.mode === "asym" ? (p.isTerrorist ? "💣" : "🚩") : "🎮";
        card.innerHTML = `${role} ${escapeHtml(p.name)} — <b>${p.score}</b>` + (p.isOut ? " 💥" : "");
        scores.appendChild(card);
    });

    // --- банк и ставки
    const specPot = s.bets.reduce((a, b) => a + b.amount, 0);
    $("mine-bank-hint").textContent = s.mode === "solo"
        ? "Одиночный режим — ставок нет, только рекорды."
        : (s.bank > 0 ? `Банк ante: ${s.bank}💰 → победителю ${Math.floor(s.bank * 0.95)}💰 (комиссия 5%). ` : "Банк пуст — игроки вносят ante при готовности. ") +
          (specPot > 0 ? `Ставки наблюдателей: ${specPot}💰.` : "") + " Пул ставок делится между угадавшими (−5%).";

    const betsList = $("mine-bets-list");
    betsList.innerHTML = "";
    if (!s.bets.length) {
        const li = document.createElement("li");
        li.className = "empty-row";
        li.textContent = "ставок наблюдателей нет";
        betsList.appendChild(li);
    } else {
        s.bets.forEach((b) => {
            const li = document.createElement("li");
            li.textContent = `${b.name} → ${b.side}: ${b.amount}💰`;
            betsList.appendChild(li);
        });
    }

    // ставка наблюдателя
    const canBet = s.bettingOpen && !me;
    $("mine-bet-box").hidden = !canBet;
    if (canBet) {
        const select = $("mine-bet-target");
        const prev = select.value;
        select.innerHTML = "";
        s.participants.forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p.connectionId;
            opt.textContent = p.name;
            select.appendChild(opt);
        });
        if (prev && s.participants.some((p) => p.connectionId === prev)) select.value = prev;
    }

    // --- мой рекорд
    $("mine-my-record").textContent = s.myRecord
        ? `Лучший счёт: ${s.myRecord.bestScore}` +
          (s.myRecord.bestTimeSeconds > 0 ? ` · лучшее время: ${formatTime(s.myRecord.bestTimeSeconds)}` : "") +
          ` · игр: ${s.myRecord.games}, побед: ${s.myRecord.wins}`
        : "Сыграйте партию, чтобы установить рекорд.";

    // --- списки людей
    const playersList = $("mine-players-list");
    playersList.innerHTML = "";
    if (!s.participants.length) {
        playersList.innerHTML = `<li class="empty-row">игроков нет</li>`;
    } else {
        s.participants.forEach((p) => {
            const li = document.createElement("li");
            if (p.isOut) li.classList.add("out");
            if (p.connectionId === s.turnId && !s.isFinished) li.classList.add("turn-now");
            const role = s.mode === "asym" ? (p.isTerrorist ? "💣 террорист" : "🚩 сапёр") : "";
            li.innerHTML = `<span>${escapeHtml(p.name)}${p.isOut ? " 💥" : ""}${p.isReady && !s.isStarted ? " ✔" : ""}</span>` +
                `<span class="mrole">${role} ${p.score} очк.${p.connectionId === myId ? " · вы" : ""}</span>`;
            playersList.appendChild(li);
        });
    }

    const specList = $("mine-spec-list");
    specList.innerHTML = "";
    $("mine-spec-count").textContent = s.spectators.length;
    if (!s.spectators.length) {
        specList.innerHTML = `<li class="empty-row">никого нет</li>`;
    } else {
        s.spectators.forEach((p) => {
            const li = document.createElement("li");
            li.innerHTML = `<span>👁 ${escapeHtml(p.name)}${p.isModerator ? " 🛡" : ""}</span>` +
                (p.connectionId === myId ? `<span class="who">это вы</span>` : "");
            specList.appendChild(li);
        });
    }
}

/** Перерисовать клетки поля (DOM создаётся один раз на размер). */
function renderMineField(s, me, myTurn, placing) {
    const field = $("mine-field");
    const key = `${s.width}x${s.height}`;

    if (mineFieldKey !== key) {
        mineFieldKey = key;
        field.innerHTML = "";
        // размер клетки под ширину поля: тяжёлое 30×16 мельче
        const size = s.width > 20 ? 26 : s.width > 12 ? 30 : 36;
        field.style.setProperty("--cell-size", size + "px");
        field.style.gridTemplateColumns = `repeat(${s.width}, var(--cell-size))`;
        for (let i = 0; i < s.width * s.height; i++) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "mcell";
            btn.dataset.index = i;
            field.appendChild(btn);
        }
    }

    const interactive = s.isStarted && !s.isFinished && (placing || (myTurn && !s.isPlacing));

    for (let i = 0; i < s.cells.length; i++) {
        const btn = field.children[i];
        const v = s.cells[i];
        btn.className = "mcell";
        btn.textContent = "";
        btn.disabled = !interactive;

        if (v === -1) {
            // закрыта
        } else if (v === -2) {
            btn.classList.add("flag");
            btn.textContent = "🚩";
        } else if (v === -3) {
            btn.classList.add("mine", "open");
            btn.textContent = "💣";
            if (i === s.explodedIndex) btn.classList.add("boom");
        } else {
            btn.classList.add("open");
            if (v > 0) {
                btn.classList.add("n" + v);
                btn.textContent = v;
            }
        }
        if (placing) btn.classList.add("placing");
    }
}

// --------------------------------------------------- действия: сапёр

$("mine-field").addEventListener("click", async (e) => {
    const btn = e.target.closest(".mcell");
    if (!btn || !connection || btn.disabled) return;
    const index = Number(btn.dataset.index);
    try {
        if (mineState && mineState.isPlacing)
            await connection.invoke("MinePlace", index);
        else
            await connection.invoke("MineOpen", index);
    } catch (err) { console.error(err); }
});

$("mine-field").addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const btn = e.target.closest(".mcell");
    if (!btn || !connection || btn.disabled) return;
    if (mineState && mineState.isPlacing) return;
    try { await connection.invoke("MineFlag", Number(btn.dataset.index)); } catch (err) { console.error(err); }
});

$("mine-join-button").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("MineJoin"); } catch (err) { console.error(err); }
});

$("mine-leave-button").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("MineLeave"); } catch (err) { console.error(err); }
});

$("mine-ready-button").addEventListener("click", async () => {
    if (!connection) return;
    const ante = Number($("mine-ante-input").value) || 10;
    try { await connection.invoke("MineReady", ante); } catch (err) { console.error(err); }
});

$("mine-place-done").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("MineFinishPlacing"); } catch (err) { console.error(err); }
});

$("mine-surrender-button").addEventListener("click", async () => {
    if (!connection) return;
    if (!confirm("Сдаться? Партия будет засчитана как поражение.")) return;
    try { await connection.invoke("MineSurrender"); } catch (err) { console.error(err); }
});

$("mine-restart-button").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("MineRestart"); } catch (err) { console.error(err); }
});

$("mine-bet-button").addEventListener("click", async () => {
    if (!connection) return;
    const target = $("mine-bet-target").value;
    const amount = Number($("mine-bet-amount").value);
    if (!target) { showToast("Выберите игрока для ставки.", "error"); return; }
    if (!Number.isInteger(amount) || amount < 10) { showToast("Минимальная ставка — 10 монет.", "error"); return; }
    try { await connection.invoke("MineBet", target, amount); } catch (err) { console.error(err); }
});

$("mine-exit-room").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("LeaveRoom"); } catch (err) { console.error(err); }
});

$("mine-delete-room").addEventListener("click", async () => {
    if (!connection) return;
    if (!confirm("Удалить эту комнату? Все участники вернутся в лобби.")) return;
    try { await connection.invoke("DeleteRoom", null); } catch (err) { console.error(err); }
});

// ============================================================ отрисовка: комната

function renderRoom(s) {
    if (!s) return;

    const me = s.players.concat(s.spectators).find((p) => p.connectionId === myId);
    if (me) mySide = me.side;

    $("room-title").textContent = (s.hasPassword ? "🔒 " : "") + s.roomName;
    $("room-my-name").textContent = myName + (isModerator ? " 🛡" : "");
    $("delete-room-button").hidden = !(s.isHost || isModerator);
    setConnection(true, "онлайн");

    // --- роли
    document.querySelectorAll(".role").forEach((btn) => {
        const side = btn.dataset.side;
        btn.classList.toggle("selected", side === mySide);
        const takenX = s.playerXId !== "" && s.playerXId !== myId;
        const takenO = s.playerOId !== "" && s.playerOId !== myId;
        if (side === "X") btn.classList.toggle("taken", takenX);
        if (side === "O") btn.classList.toggle("taken", takenO);
    });

    $("seat-x").textContent = s.playerXId ? s.playerXName : "свободно";
    $("seat-o").textContent = s.playerOId ? s.playerOName : "свободно";
    $("seat-spec").textContent = s.spectators.length + " чел. смотрят игру";

    // --- карточки игроков над доской
    $("name-x").textContent = s.playerXId ? s.playerXName : "ждём игрока…";
    $("name-o").textContent = s.playerOId ? s.playerOName : "ждём игрока…";
    const readyX = s.players.find((p) => p.side === "X");
    const readyO = s.players.find((p) => p.side === "O");
    $("ready-x").textContent = readyX && readyX.isReady ? "готов ✔" : "";
    $("ready-o").textContent = readyO && readyO.isReady ? "готов ✔" : "";

    const myTurn = s.isStarted && !s.isFinished && s.turn === mySide;
    $("card-x").classList.toggle("active-turn", s.isStarted && !s.isFinished && s.turn === "X");
    $("card-o").classList.toggle("active-turn", s.isStarted && !s.isFinished && s.turn === "O");

    // --- доска
    for (let i = 0; i < 9; i++) {
        const value = s.board[i] || "";
        const cell = cells[i];

        if (lastBoard[i] !== value) {
            cell.innerHTML = value
                ? `<span class="mark-${value.toLowerCase()}">${value === "X" ? "✕" : "◯"}</span>`
                : "<span></span>";
            lastBoard[i] = value;
        }

        cell.classList.toggle("win", (s.winLine || []).includes(i));
        cell.disabled = !myTurn || value !== "";
    }

    // --- подпись под доской
    const turnText = $("turn-text");
    if (s.isFinished) {
        turnText.innerHTML = s.isDraw
            ? "Ничья — партия закончена."
            : `Победа: <b class="${s.winner === "X" ? "x-color" : "o-color"}">${s.winner === "X" ? s.playerXName : s.playerOName}</b> 🎉 +${s.winnerPrize}💰`;
    } else if (!s.isStarted) {
        turnText.innerHTML = s.playerXId && s.playerOId
            ? "Оба игрока на месте. Нажмите <b>«Готов»</b>, чтобы начать матч."
            : "Ожидание игроков…";
    } else {
        turnText.innerHTML = myTurn ? "Ваш ход!" : `Ходит <b>${s.turn === "X" ? s.playerXName : s.playerOName}</b> (${s.turn})`;
    }

    // --- кнопка готовности / рестарта
    const readyBtn = $("ready-button");
    const restartBtn = $("restart-button");
    const isPlayer = mySide === "X" || mySide === "O";
    const iAmReady = isPlayer && me ? me.isReady : false;

    readyBtn.hidden = s.isStarted || s.isFinished;
    readyBtn.disabled = !isPlayer || s.isStarted;
    readyBtn.className = "btn big " + (iAmReady ? "ready" : "primary");
    readyBtn.textContent = iAmReady ? "Готово! Ждём соперника…" : "Готов / Начать матч";

    restartBtn.hidden = !s.isFinished;

    $("match-hint").textContent = !isPlayer
        ? "Вы наблюдатель: выберите сторону, чтобы играть, или сделайте ставку."
        : iAmReady
            ? "Вы готовы. Матч начнётся, когда второй игрок тоже нажмёт кнопку."
            : s.isFinished
                ? "Партия окончена — нажмите «Играть снова»."
                : `Нажмите кнопку, когда будете готовы играть. Награда за победу: ${s.winnerPrize}💰`;

    // --- ставки
    const bettingBox = $("betting-box");
    const canBet = !isPlayer && s.bettingOpen;
    bettingBox.classList.toggle("closed", !canBet);
    $("bet-x").disabled = !canBet;
    $("bet-o").disabled = !canBet;
    $("bet-amount").disabled = !canBet;

    const myBet = (s.bets || []).find((b) => b.name.toLowerCase() === myName.toLowerCase());
    $("bet-hint").textContent = !s.bettingOpen
        ? (s.isFinished ? "Партия окончена — ставки рассчитаны." : "Матч идёт — ставки больше не принимаются.")
        : myBet
            ? `Ваша ставка: ${myBet.amount}💰 на ${myBet.side === "X" ? "✕" : "◯"}. Угадаете — ×2!`
            : canBet
                ? "Поставьте на победителя до начала матча. Угадали — ×2, нет — сгорает."
                : "Ставки доступны наблюдателям до начала матча.";

    renderBets(s.bets || []);

    // --- списки людей
    renderPeople($("players-list"), s.players, (p) => `${p.side === "X" ? "✕" : "◯"} ${p.name}`);
    renderPeople($("spectators-list"), s.spectators, (p) => `👁 ${p.name}`);
    $("spec-count").textContent = s.spectators.length;
}

function renderBets(bets) {
    const list = $("bets-list");
    list.innerHTML = "";
    if (!bets.length) {
        const li = document.createElement("li");
        li.className = "empty-row";
        li.textContent = "ставок пока нет";
        list.appendChild(li);
        return;
    }

    const potX = bets.filter((b) => b.side === "X").reduce((a, b) => a + b.amount, 0);
    const potO = bets.filter((b) => b.side === "O").reduce((a, b) => a + b.amount, 0);

    const total = document.createElement("li");
    total.className = "bet-total";
    total.innerHTML = `Банк: <b class="x-color">✕ ${potX}💰</b> · <b class="o-color">◯ ${potO}💰</b>`;
    list.appendChild(total);

    bets.forEach((b) => {
        const li = document.createElement("li");
        const cls = b.side === "X" ? "x-color" : "o-color";
        li.innerHTML = `<span class="${cls}">${b.side === "X" ? "✕" : "◯"}</span> ${escapeHtml(b.name)} — ${b.amount}💰`;
        list.appendChild(li);
    });
}

function renderPeople(list, items, titleFn) {
    list.innerHTML = "";
    if (!items.length) {
        const li = document.createElement("li");
        li.className = "empty-row";
        li.textContent = "никого нет";
        list.appendChild(li);
        return;
    }
    items.forEach((p) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${escapeHtml(titleFn(p))}${p.isModerator ? " 🛡" : ""}</span>` +
            (p.isReady ? `<span class="rdy">готов ✔</span>` : "") +
            (p.connectionId === myId ? `<span class="who">это вы</span>` : "");
        list.appendChild(li);
    });
}

// ----------------------------------------------------------- чат

/** Вся история сразу (приходит один раз после входа). */
function renderChatHistory(messages) {
    chatList.innerHTML = "";
    if (!messages.length) {
        const li = document.createElement("li");
        li.className = "chat-empty";
        li.textContent = "Сообщений пока нет — поздоровайтесь первым!";
        chatList.appendChild(li);
        return;
    }
    messages.forEach((message) => appendChatMessage(message, true));
}

/** Одно новое сообщение. */
function appendChatMessage(message, skipScrollCheck) {
    if (!message) return;

    // убираем заглушку "сообщений пока нет"
    const placeholder = chatList.querySelector(".chat-empty");
    if (placeholder) placeholder.remove();

    // если пользователь не листал историю вверх - прокручиваем вниз после вставки
    const atBottom = skipScrollCheck ||
        chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 60;

    const li = document.createElement("li");

    if (message.isSystem) {
        li.className = "system";
        li.textContent = message.text;
    } else {
        const isMine = message.author === myName;
        li.className = isMine ? "mine" : "";

        const sideClass = message.isModerator
            ? "side-mod"
            : message.side === "X" ? "side-x" : message.side === "O" ? "side-o" : "side-spec";
        const mark = message.isModerator
            ? "🛡 " : message.side === "X" ? "✕ " : message.side === "O" ? "◯ " : "👁 ";

        li.innerHTML =
            `<div class="chat-head">` +
            `<span class="chat-author ${sideClass}">${escapeHtml(mark + message.author)}</span>` +
            `<span class="chat-time">${escapeHtml(message.time)}</span>` +
            `</div>` +
            `<div class="chat-text">${escapeHtml(message.text)}</div>`;
    }

    chatList.appendChild(li);

    // держим в DOM не больше 80 сообщений
    while (chatList.children.length > 80) chatList.removeChild(chatList.firstChild);

    if (atBottom) chatList.scrollTop = chatList.scrollHeight;
}

// отправка сообщения в чат
chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !connection) return;

    chatInput.value = "";
    try {
        await connection.invoke("SendMessage", text);
    } catch (err) {
        showToast("Сообщение не отправлено — нет связи с сервером", "error");
        console.error(err);
    }
});

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text ?? "";
    return div.innerHTML;
}

function showBanner(title, text) {
    $("banner-title").textContent = title;
    $("banner-text").textContent = text;
    banner.className = "banner show";
}

// ============================================================ конфетти

const canvas = $("confetti");
const ctx = canvas.getContext("2d");
let pieces = [];
let rafId = null;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

const colors = ["#38e1ff", "#ffb347", "#7c5cff", "#3ddc97", "#ff6b81", "#ffd76a"];

function confetti(count) {
    for (let i = 0; i < count; i++) {
        pieces.push({
            x: Math.random() * canvas.width,
            y: -20 - Math.random() * canvas.height * 0.4,
            size: 6 + Math.random() * 8,
            color: colors[Math.floor(Math.random() * colors.length)],
            speedY: 2 + Math.random() * 3,
            speedX: -2 + Math.random() * 4,
            angle: Math.random() * Math.PI,
            spin: -0.15 + Math.random() * 0.3
        });
    }
    if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    pieces = pieces.filter((p) => p.y < canvas.height + 30);
    pieces.forEach((p) => {
        p.x += p.speedX;
        p.y += p.speedY;
        p.angle += p.spin;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
    });

    if (pieces.length) {
        rafId = requestAnimationFrame(tick);
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        rafId = null;
    }
}

// ============================================================ фоновая анимация
// Плавающие иконки крестиков-ноликов и мини-поля сапёра на свободном фоне.

(function backgroundAnimation() {
    const bgCanvas = $("bg-anim");
    if (!bgCanvas) return;
    const bgCtx = bgCanvas.getContext("2d");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const C = { x: "56,225,255", o: "255,179,71", accent: "124,92,255", mine: "255,107,129", ok: "61,220,151" };
    let icons = [];
    let W = 0, H = 0;

    /** Свободные зоны фона: края экрана, полоса под топбаром и низ страницы. */
    function freeRects() {
        const spots = [];
        const panels = Array.from(document.querySelectorAll(".screen.active .panel, .screen.active .join-card"))
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0);
        const margin = 12;
        const overlaps = (x, y, s) => panels.some((p) =>
            x + s > p.left - margin && x - s < p.right + margin &&
            y + s > p.top - margin && y - s < p.bottom + margin);

        const step = 80;
        for (let x = 36; x < W - 36; x += step) {
            for (let y = 36; y < H - 36; y += step) {
                if (!overlaps(x, y, 38)) spots.push({ x, y });
            }
        }

        // если панели заняли весь экран — размещаем иконки по самым краям,
        // где они лишь слегка заходят под полупрозрачные карточки
        if (spots.length < 6) {
            const edge = 22;
            for (let x = 60; x < W - 40; x += 130) {
                spots.push({ x, y: edge + Math.random() * 14 });
                spots.push({ x: x + 60, y: H - edge - Math.random() * 14 });
            }
            for (let y = 90; y < H - 60; y += 150) {
                spots.push({ x: edge, y });
                spots.push({ x: W - edge, y: y + 70 });
            }
        }
        return spots;
    }

    function makeIcon(spot) {
        const roll = Math.random();
        const type = roll < 0.34 ? "x" : roll < 0.68 ? "o" : "mine";
        const icon = {
            type,
            x: spot.x + (Math.random() - 0.5) * 24,
            y: spot.y + (Math.random() - 0.5) * 24,
            size: type === "mine" ? 24 + Math.random() * 10 : 16 + Math.random() * 12,
            vx: (Math.random() - 0.5) * 0.22,
            vy: (Math.random() - 0.5) * 0.22,
            angle: (Math.random() - 0.5) * 0.5,
            spin: (Math.random() - 0.5) * 0.0022,
            phase: Math.random() * Math.PI * 2,
            alpha: 0.10 + Math.random() * 0.14,
            // мини-поле сапёра 3×3: одна мина, пара чисел, остальное закрыто
            cells: null
        };
        if (type === "mine") {
            icon.cells = Array.from({ length: 9 }, () => ({ state: "closed", n: 0 }));
            const mineIdx = Math.floor(Math.random() * 9);
            icon.cells[mineIdx].state = "mine";
            const openCount = 2 + Math.floor(Math.random() * 3);
            for (let k = 0; k < openCount; k++) {
                const idx = Math.floor(Math.random() * 9);
                if (icon.cells[idx].state === "closed") {
                    icon.cells[idx].state = "open";
                    icon.cells[idx].n = 1 + Math.floor(Math.random() * 2);
                }
            }
            if (Math.random() < 0.5) {
                const idx = Math.floor(Math.random() * 9);
                if (icon.cells[idx].state === "closed") icon.cells[idx].state = "flag";
            }
        }
        return icon;
    }

    function rebuild() {
        W = bgCanvas.width = window.innerWidth;
        H = bgCanvas.height = window.innerHeight;

        // на экране входа свой фон — портал; плавающие иконки только в лобби и комнате
        if ($("screen-join").classList.contains("active")) {
            icons = [];
            bgCtx.clearRect(0, 0, W, H);
            return;
        }

        const spots = freeRects();
        const count = Math.min(26, spots.length);
        icons = [];
        // перемешиваем свободные точки и берём нужное количество
        for (let i = spots.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [spots[i], spots[j]] = [spots[j], spots[i]];
        }
        for (let i = 0; i < count; i++) icons.push(makeIcon(spots[i]));
        // статичный кадр сразу: иконки видны даже если анимация приостановлена
        drawFrame(performance.now());
    }

    function drawX(icon, glow) {
        const s = icon.size / 2;
        bgCtx.strokeStyle = `rgba(${C.x},${icon.alpha + glow})`;
        bgCtx.lineWidth = Math.max(2.5, icon.size * 0.14);
        bgCtx.lineCap = "round";
        bgCtx.beginPath();
        bgCtx.moveTo(-s, -s); bgCtx.lineTo(s, s);
        bgCtx.moveTo(s, -s); bgCtx.lineTo(-s, s);
        bgCtx.stroke();
    }

    function drawO(icon, glow) {
        bgCtx.strokeStyle = `rgba(${C.o},${icon.alpha + glow})`;
        bgCtx.lineWidth = Math.max(2.5, icon.size * 0.14);
        bgCtx.beginPath();
        bgCtx.arc(0, 0, icon.size / 2, 0, Math.PI * 2);
        bgCtx.stroke();
    }

    function drawMine(icon, glow) {
        const cell = icon.size / 3;
        const half = icon.size / 2;
        for (let i = 0; i < 9; i++) {
            const cx = -half + (i % 3) * cell;
            const cy = -half + Math.floor(i / 3) * cell;
            const c = icon.cells[i];
            const pad = 1.2;
            if (c.state === "closed" || c.state === "flag") {
                bgCtx.fillStyle = `rgba(${C.accent},${icon.alpha + glow})`;
                bgCtx.fillRect(cx + pad, cy + pad, cell - pad * 2, cell - pad * 2);
                if (c.state === "flag") {
                    bgCtx.fillStyle = `rgba(${C.mine},${icon.alpha * 2.4 + glow})`;
                    bgCtx.beginPath();
                    bgCtx.moveTo(cx + cell * 0.35, cy + cell * 0.22);
                    bgCtx.lineTo(cx + cell * 0.75, cy + cell * 0.38);
                    bgCtx.lineTo(cx + cell * 0.35, cy + cell * 0.54);
                    bgCtx.closePath();
                    bgCtx.fill();
                }
            } else {
                bgCtx.strokeStyle = `rgba(255,255,255,${icon.alpha * 0.7 + glow})`;
                bgCtx.lineWidth = 1;
                bgCtx.strokeRect(cx + pad, cy + pad, cell - pad * 2, cell - pad * 2);
                if (c.state === "mine") {
                    bgCtx.fillStyle = `rgba(${C.mine},${icon.alpha * 2.2 + glow})`;
                    bgCtx.beginPath();
                    bgCtx.arc(cx + cell / 2, cy + cell / 2, cell * 0.22, 0, Math.PI * 2);
                    bgCtx.fill();
                } else if (c.n > 0) {
                    bgCtx.fillStyle = c.n === 1
                        ? `rgba(${C.x},${icon.alpha * 2.4 + glow})`
                        : `rgba(${C.ok},${icon.alpha * 2.4 + glow})`;
                    bgCtx.font = `700 ${Math.round(cell * 0.6)}px "Segoe UI", sans-serif`;
                    bgCtx.textAlign = "center";
                    bgCtx.textBaseline = "middle";
                    bgCtx.fillText(String(c.n), cx + cell / 2, cy + cell / 2 + 1);
                }
            }
        }
    }

    function drawFrame(time) {
        bgCtx.clearRect(0, 0, W, H);
        icons.forEach((icon) => {
            const glow = Math.sin(time / 1600 + icon.phase) * 0.05;
            bgCtx.save();
            bgCtx.translate(icon.x, icon.y + Math.sin(time / 2400 + icon.phase) * 6);
            bgCtx.rotate(icon.angle);
            if (icon.type === "x") drawX(icon, glow);
            else if (icon.type === "o") drawO(icon, glow);
            else drawMine(icon, glow);
            bgCtx.restore();
        });
    }

    function loop(time) {
        icons.forEach((icon) => {
            icon.x += icon.vx;
            icon.y += icon.vy;
            icon.angle += icon.spin;
            // мягко разворачиваем иконку у краёв экрана
            if (icon.x < 30 || icon.x > W - 30) icon.vx *= -1;
            if (icon.y < 30 || icon.y > H - 30) icon.vy *= -1;
        });
        drawFrame(time);
        requestAnimationFrame(loop);
    }

    let resizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(rebuild, 250);
    });

    // при смене экрана свободные зоны меняются — пересобираем иконки
    const observer = new MutationObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(rebuild, 350);
    });
    document.querySelectorAll(".screen").forEach((s) =>
        observer.observe(s, { attributes: true, attributeFilter: ["class"] }));

    rebuild();
    if (!reduceMotion) requestAnimationFrame(loop);
})();
