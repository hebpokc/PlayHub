"use strict";

// ------------------------------------------------------------ элементы DOM
const $ = (id) => document.getElementById(id);

const screens = { join: $("screen-join"), lobby: $("screen-lobby"), room: $("screen-room") };
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
        renderRoom(snapshot);
    });

    connection.on("RoomLeft", () => {
        roomState = null;
        showScreen("lobby");
    });

    connection.on("RoomDeleted", (message) => {
        roomState = null;
        showScreen("lobby");
        showToast(message, "error");
    });

    connection.on("BalanceUpdated", (balance) => {
        myBalance = balance;
        renderBalance();
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
}

function renderBalance() {
    $("my-balance").textContent = `💰 ${myBalance}`;
    $("room-my-balance").textContent = `💰 ${myBalance}`;
}

// ============================================================ действия: лобби

$("create-room-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!connection) return;
    const name = $("room-name-input").value.trim();
    try {
        await connection.invoke("CreateRoom", name);
        $("room-name-input").value = "";
        showScreen("room");
    } catch (err) { console.error(err); }
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

function renderLobby(s) {
    setConnection(true, "онлайн");
    $("online-count").textContent = s.users.length;
    $("users-count").textContent = s.users.length;
    $("my-name").textContent = myName + (isModerator ? " 🛡" : "");
    $("mod-panel").hidden = !isModerator;

    renderRooms(s.rooms || []);
    renderUsers(s.users || []);
    renderLeaders(s.leaderboard || []);

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

        const info = document.createElement("div");
        info.className = "room-info";
        info.innerHTML =
            `<div class="room-name">${escapeHtml(r.name)} ${r.inGame ? '<span class="live">идёт игра</span>' : ""}</div>` +
            `<div class="room-sub">хост: ${escapeHtml(r.hostName)} · ✕/◯: ${r.playersCount} · 👁: ${r.spectatorsCount}` +
            (r.potX + r.potO > 0 ? ` · банк ставок: ${r.potX + r.potO}💰` : "") + `</div>`;

        const join = document.createElement("button");
        join.className = "btn primary small";
        join.textContent = "Войти";
        join.addEventListener("click", async () => {
            try {
                await connection.invoke("JoinRoom", r.id);
                showScreen("room");
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

// ============================================================ отрисовка: комната

function renderRoom(s) {
    if (!s) return;

    const me = s.players.concat(s.spectators).find((p) => p.connectionId === myId);
    if (me) mySide = me.side;

    $("room-title").textContent = s.roomName;
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
