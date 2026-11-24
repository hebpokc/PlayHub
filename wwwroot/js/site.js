"use strict";

// ------------------------------------------------------------ элементы DOM
const $ = (id) => document.getElementById(id);

const screens = { join: $("screen-join"), lobby: $("screen-lobby"), room: $("screen-room"), mine: $("screen-mine") };
const joinForm = $("join-form");
const nameInput = $("name-input");
const joinStatus = $("join-status");
const toastHost = $("toast-host");
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
let myAvatar = "😎";
let isModerator = false;
let lobbyState = null;      // последний снимок лобби
let lobbySnapshotAt = 0;    // когда получен снимок — для локального отсчёта таймеров комнат
let roomState = null;       // последний снимок комнаты
let mineState = null;       // последний снимок сапёра
let lastBoard = [];
let myModPassword = null;   // для повторного входа после реконнекта
let bonusState = null;      // { nextBonusSeconds, dailyAvailable }
let bonusDeadlineAt = 0;    // локальный дедлайн бонуса +50 (мс)

// настройки звука и эффектов (переживают перезагрузку)
let soundOn = localStorage.getItem("ph-sound") !== "off";
let fxOn = localStorage.getItem("ph-fx") !== "off";

function showScreen(name) {
    Object.keys(screens).forEach((k) => screens[k].classList.toggle("active", k === name));
}

// ---------------------------------------------------- звук (WebAudio, без файлов)
let audioCtx = null;
function sfx(kind) {
    if (!soundOn) return;
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume();
        const now = audioCtx.currentTime;
        const tone = (freq, start, dur, type, vol) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = type || "sine";
            osc.frequency.setValueAtTime(freq, now + start);
            gain.gain.setValueAtTime(0.0001, now + start);
            gain.gain.exponentialRampToValueAtTime(vol || 0.12, now + start + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(now + start);
            osc.stop(now + start + dur + 0.05);
        };
        if (kind === "tick") tone(660, 0, 0.06, "triangle", 0.07);
        else if (kind === "pop") tone(440, 0, 0.09, "triangle", 0.1);
        else if (kind === "coin") { tone(880, 0, 0.09, "square", 0.06); tone(1320, 0.07, 0.14, "square", 0.06); }
        else if (kind === "win") { tone(523, 0, 0.12, "triangle"); tone(659, 0.1, 0.12, "triangle"); tone(784, 0.2, 0.22, "triangle"); }
        else if (kind === "err") { tone(220, 0, 0.14, "sawtooth", 0.07); tone(160, 0.1, 0.18, "sawtooth", 0.07); }
    } catch (e) { /* звук не критичен */ }
}

// пульт: звук и фоновые эффекты
function applyFxState() {
    document.body.classList.toggle("fx-off", !fxOn);
    $("fx-btn").setAttribute("aria-pressed", String(fxOn));
    $("fx-btn").textContent = fxOn ? "✨" : "🌑";
    $("snd-btn").setAttribute("aria-pressed", String(soundOn));
    $("snd-btn").textContent = soundOn ? "🔊" : "🔇";
}
$("fx-btn").addEventListener("click", () => {
    fxOn = !fxOn;
    localStorage.setItem("ph-fx", fxOn ? "on" : "off");
    applyFxState();
    sfx("tick");
});
$("snd-btn").addEventListener("click", () => {
    soundOn = !soundOn;
    localStorage.setItem("ph-sound", soundOn ? "on" : "off");
    applyFxState();
    sfx("pop");
});
applyFxState();

// ------------------------------------------------ Toast Slide-in: стек уведомлений
function showToast(text, kind) {
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = text;
    el.addEventListener("click", () => dismiss(el));
    toastHost.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    // держим не больше 4 тостов: старые убираем сразу
    while (toastHost.children.length > 4) dismiss(toastHost.firstElementChild, true);
    setTimeout(() => dismiss(el), 3400);
    if (kind === "error") sfx("err");
    else if (kind === "ok") sfx("pop");

    function dismiss(node, instant) {
        if (!node || !node.parentNode) return;
        if (instant) { node.remove(); return; }
        node.classList.remove("show");
        setTimeout(() => node.remove(), 320);
    }
}

// ------------------------------------------------------- CoinFly к балансу
function activeBalanceEl() {
    if (screens.mine.classList.contains("active")) return $("mine-my-balance");
    if (screens.room.classList.contains("active")) return $("room-my-balance");
    return $("my-balance");
}

function coinFly(fromEl, count) {
    if (!fxOn || !fromEl) return;
    const target = activeBalanceEl();
    const from = fromEl.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const sx = from.left + from.width / 2, sy = from.top + from.height / 2;
    const tx = to.left + to.width / 2, ty = to.top + to.height / 2;
    const n = Math.min(count || 6, 8);
    for (let i = 0; i < n; i++) {
        const coin = document.createElement("span");
        coin.className = "fly-coin";
        coin.textContent = "🪙";
        coin.style.left = sx + "px";
        coin.style.top = sy + "px";
        document.body.appendChild(coin);
        const arcX = (sx + tx) / 2 + (Math.random() - 0.5) * 160;
        const arcY = Math.min(sy, ty) - 60 - Math.random() * 70;
        const anim = coin.animate([
            { transform: "translate(-50%,-50%) scale(.7)", opacity: 0, offset: 0 },
            { transform: `translate(${arcX - sx - 10}px, ${arcY - sy - 10}px) scale(1.15)`, opacity: 1, offset: 0.45 },
            { transform: `translate(${tx - sx - 10}px, ${ty - sy - 10}px) scale(.4)`, opacity: 0.9, offset: 1 }
        ], { duration: 650 + Math.random() * 250, delay: i * 70, easing: "cubic-bezier(.3,.6,.4,1)", fill: "forwards" });
        anim.onfinish = () => {
            coin.remove();
            if (i === n - 1) {
                target.classList.remove("balance-bump");
                void target.offsetWidth;
                target.classList.add("balance-bump");
            }
        };
    }
    sfx("coin");
}

// ============================================================ подключение

function buildConnection() {
    connection = new signalR.HubConnectionBuilder()
        .withUrl("/hubs/game")
        .withAutomaticReconnect()
        .configureLogging(signalR.LogLevel.Warning)
        .build();
    registerHandlers();
    return connection;
}

/** Гостевой канал: живой онлайн, presence и лента побед ещё до входа. */
async function startGuestConnection() {
    try {
        await buildConnection().start();

        // возврат со страницы правил: автоматически входим обратно в лобби
        const saved = sessionStorage.getItem("ph-session");
        if (saved) {
            sessionStorage.removeItem("ph-session");
            try {
                const s = JSON.parse(saved);
                if (s && s.name && Date.now() - (s.at || 0) < 10 * 60 * 1000) {
                    myName = s.name;
                    myModPassword = s.mod || null;
                    myAvatar = s.avatar || myAvatar;
                    joinStatus.className = "status";
                    joinStatus.textContent = "Возвращаемся в лобби…";
                    await connection.invoke("Join", myName, myModPassword, myAvatar);
                    // возвращаемся и в комнату, если уходили из неё
                    if (s.room) {
                        lastRoomPassword = s.roomPass || null;
                        try { await connection.invoke("JoinRoom", s.room, s.roomPass || null); }
                        catch (e) { /* комнату удалили — останемся в лобби */ }
                    }
                    return;
                }
            } catch (e) { /* повреждённая метка — обычный вход */ }
        }

        const snapshot = await connection.invoke("WatchLobby");
        renderJoinPreview(snapshot);
    } catch (err) {
        console.error(err);
    }
}
startGuestConnection();

// перед уходом на страницу правил запоминаем сессию — вернёмся сразу в лобби
document.querySelectorAll('a[href="rules.html"]').forEach((link) => {
    link.addEventListener("click", () => {
        if (!myId) return;
        sessionStorage.setItem("ph-session", JSON.stringify({
            name: myName, mod: myModPassword, avatar: myAvatar, at: Date.now(),
            room: roomState ? roomState.roomId : mineState ? mineState.roomId : null,
            roomPass: lastRoomPassword
        }));
    });
});

// ------------------------------------------------- форма входа (превью-дизайн)
let joinTab = "player";
let joinBusy = false;

const avatarsList = ["😎", "🦊", "👾", "🐸", "🤖", "🦄", "🐼", "🐙", "🐯", "🐺", "🦁", "🐲"];

(function initAvatarPicker() {
    const row = $("av-row");
    const saved = localStorage.getItem("ph-avatar");
    if (saved && avatarsList.includes(saved)) myAvatar = saved;
    avatarsList.forEach((emoji) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "av" + (emoji === myAvatar ? " sel" : "");
        btn.textContent = emoji;
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-checked", String(emoji === myAvatar));
        btn.addEventListener("click", () => {
            myAvatar = emoji;
            localStorage.setItem("ph-avatar", emoji);
            row.querySelectorAll(".av").forEach((b) => {
                b.classList.toggle("sel", b === btn);
                b.setAttribute("aria-checked", String(b === btn));
            });
            $("av-cap").textContent = `Аватар: ${emoji}`;
            sfx("pop");
        });
        row.appendChild(btn);
    });
    $("av-cap").textContent = `Аватар: ${myAvatar}`;
})();

// вкладки Игрок / Модератор
document.querySelectorAll("#join-tabs button[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
        joinTab = tab.dataset.tab;
        $("join-tabs").dataset.active = joinTab;
        document.querySelectorAll("#join-tabs button[data-tab]").forEach((t) =>
            t.setAttribute("aria-selected", String(t === tab)));
        $("mod-pass-field").hidden = joinTab !== "mod";
        if (joinTab === "mod") $("mod-pass-input").focus();
        sfx("tick");
    });
});

function fieldError(fieldId, on) {
    const field = $(fieldId);
    field.classList.remove("is-error");
    if (on) {
        void field.offsetWidth;   // перезапуск shake-анимации
        field.classList.add("is-error");
        sfx("err");
    }
}

function setJoinBusy(busy) {
    joinBusy = busy;
    const btn = $("join-button");
    btn.disabled = busy;
    btn.querySelector(".lbl").textContent = busy ? "Входим…" : "Войти →";
    btn.querySelector(".spinner").hidden = !busy;
}

joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (joinBusy) return;

    const name = nameInput.value.trim();
    if (name.length < 2 || !/^[\p{L}\p{N} _-]+$/u.test(name)) {
        fieldError("name-field", true);
        joinStatus.className = "status error";
        joinStatus.textContent = "Имя: 2–16 символов, без спецсимволов.";
        return;
    }
    fieldError("name-field", false);

    const pass = $("mod-pass-input").value;
    if (joinTab === "mod" && !pass) {
        fieldError("mod-pass-field", true);
        return;
    }
    fieldError("mod-pass-field", false);

    myName = name;
    myModPassword = joinTab === "mod" ? pass : null;
    setJoinBusy(true);
    joinStatus.className = "status";
    joinStatus.textContent = "Подключение к серверу…";

    try {
        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            if (connection) { try { await connection.stop(); } catch (e) { /* уже закрыт */ } }
            await buildConnection().start();
        }
        await connection.invoke("Join", myName, myModPassword, myAvatar);
    } catch (err) {
        setJoinBusy(false);
        joinStatus.className = "status error";
        joinStatus.textContent = "Сервер не отвечает. Запустите проект в Visual Studio (F5).";
        console.error(err);
    }
});

// Magnetic Button: CTA слегка тянется к курсору внутри своей зоны
(function magneticButton() {
    const zone = $("join-mag-zone");
    const btn = $("join-button");
    zone.addEventListener("mousemove", (e) => {
        if (!fxOn) return;
        const r = zone.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
        const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
        btn.style.transform = `translate(${dx * 10}px, ${dy * 8}px)`;
    });
    zone.addEventListener("mouseleave", () => (btn.style.transform = ""));
})();

// описания игр при наведении на чипы и орбитальные боксы
const gameDescriptions = {
    "Крестики-нолики": "Классика 3×3 на двоих. Победа приносит +100 монет, наблюдатели ставят на игрока до старта и забирают ×2.",
    "Сапёр": "Одиночка или PvP-дуэль. Открывай клетки, собирай очки, быстрые ходы дают множитель. Подорвался — банк сопернику.",
    "Сапёр vs Террорист": "Террорист прячет мины, сапёр рискует: каждый клик приближает к банку. «Забрать очки» — доля растёт с каждым кликом, мина забирает всё.",
    "PvP-дуэли": "Двое вносят ante в общий банк и ходят по очереди. Победитель забирает банк минус комиссия хаба 5%.",
    "Кинотеатр": "3–8 игроков ходят по кругу, 20 секунд на ход. Подорвался — выбыл и смотришь до конца. Последний выживший забирает банк.",
    "Турниры": "Таблица лидеров обновляется после каждой партии: победы, игры и очки. Лучший сапёр попадает в рекорды поля.",
    "Ставки ×2": "Наблюдатели ставят на победителя до начала матча. Угадал — ставка удваивается, ошибся — уходит в общий пул.",
    "Монеты": "Стартовый баланс 500💰. Победа в крестиках +100💰, бонус +50💰 каждые 15 минут и +25💰 за ежедневный вход.",
    "Наблюдение": "Заходи в любую комнату зрителем: следи за партией в реальном времени, общайся в чате и делай ставки."
};
const defaultChipDesc = $("chip-desc").textContent;

function bindGameDescriptions(selector, onHover) {
    document.querySelectorAll(selector).forEach((el) => {
        el.addEventListener("mouseenter", () => onHover(el.dataset.name));
        el.addEventListener("focus", () => onHover(el.dataset.name));
        el.addEventListener("mouseleave", () => onHover(null));
        el.addEventListener("blur", () => onHover(null));
    });
}
bindGameDescriptions("#game-chips .gchip", (name) => {
    $("chip-desc").textContent = name ? (gameDescriptions[name] || defaultChipDesc) : defaultChipDesc;
    if (name) sfx("tick");
});
bindGameDescriptions(".orbit-chip", (name) => {
    const cap = $("orbit-cap");
    cap.textContent = name || "";
    cap.hidden = !name;
    $("chip-desc").textContent = name ? (gameDescriptions[name] || defaultChipDesc) : defaultChipDesc;
    if (name) sfx("tick");
});

// ------------------------------------------------ живые данные на экране входа
let guestWatchTimer = null;

function renderJoinPreview(s) {
    if (!s) return;
    countUp($("join-online"), s.online || 0);
    countUp($("join-rooms"), s.rooms ? s.rooms.length : 0);
    renderPresence($("join-presence"), s.users || [], s.online || 0, $("join-presence-plus"));
}

// страховка живого счёта у гостя: если рассылка не дошла (фоновая вкладка,
// пропущенный кадр), обновляем снимок раз в 5 секунд, пока виден экран входа
guestWatchTimer = setInterval(async () => {
    if (myId || !connection || connection.state !== signalR.HubConnectionState.Connected) return;
    if (!screens.join.classList.contains("active")) return;
    try { renderJoinPreview(await connection.invoke("WatchLobby")); } catch (e) { /* сервер занят */ }
}, 5000);

/** Плавный count-up числа в элементе (setTimeout: работает и в фоновой вкладке). */
function countUp(el, to) {
    const from = Number(el.textContent) || 0;
    if (from === to) { el.textContent = to; return; }
    const start = performance.now();
    const dur = 500;
    function step() {
        const t = Math.min(1, (performance.now() - start) / dur);
        el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) setTimeout(step, 32);
    }
    step();
}

/** Presence Avatars: ряд эмодзи-аватаров с pop-эффектом для новых. */
function renderPresence(container, users, total, plusEl) {
    const seen = new Set(Array.from(container.children).map((c) => c.dataset.cid));
    container.innerHTML = "";
    users.slice(0, 8).forEach((p) => {
        const av = document.createElement("span");
        av.className = "p-av" + (seen.has(p.connectionId) ? "" : " pop");
        av.dataset.cid = p.connectionId;
        av.textContent = p.avatar || "😎";
        av.title = p.name;
        container.appendChild(av);
    });
    if (plusEl) {
        const extra = Math.max(0, total - Math.min(users.length, 8));
        plusEl.hidden = extra === 0;
        plusEl.textContent = `+${extra}`;
    }
}

// --------------------------------------------------------- Win Ticker
let tickerSignature = "";
function renderWinFeed(entries) {
    const ticker = $("win-ticker");
    if (!entries || !entries.length) { ticker.hidden = true; return; }
    const sig = entries.map((e) => `${e.name}|${e.amount}|${e.time}`).join(";");
    if (sig === tickerSignature) return;
    tickerSignature = sig;

    const track = $("ticker-track");
    track.innerHTML = "";
    // контент дублируется: translateX(-50%) даёт бесшовную петлю
    for (let copy = 0; copy < 2; copy++) {
        entries.forEach((e) => {
            const chip = document.createElement("span");
            chip.className = "tk";
            chip.innerHTML = `🏆 ${escapeHtml(e.name)} <b>+${e.amount}💰</b> ${escapeHtml(e.game)} <span class="tk-time">${escapeHtml(e.time)}</span>`;
            track.appendChild(chip);
        });
    }
    ticker.hidden = false;
}

// ------------------------------------------------------------ бонусы
function renderBonusStatus(bonus) {
    bonusState = bonus;
    bonusDeadlineAt = bonus && bonus.nextBonusSeconds > 0 ? Date.now() + bonus.nextBonusSeconds * 1000 : 0;
    updateBonusUi();
}

function updateBonusUi() {
    if (!bonusState) return;
    const daily = $("daily-bonus-button");
    daily.disabled = !bonusState.dailyAvailable;
    $("daily-bonus-text").textContent = bonusState.dailyAvailable
        ? "+25 монет за вход — забрать"
        : "уже забран сегодня — возвращайтесь завтра";

    const left = bonusDeadlineAt > 0 ? Math.max(0, Math.ceil((bonusDeadlineAt - Date.now()) / 1000)) : 0;
    const timed = $("timed-bonus-button");
    timed.disabled = left > 0;
    timed.className = "btn small " + (left > 0 ? "ghost" : "cashout");
    $("timed-bonus-text").textContent = left > 0
        ? `+50 монет через ${formatTime(left)}`
        : "+50 монет — можно забрать";
}
setInterval(updateBonusUi, 1000);

$("timed-bonus-button").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("ClaimTimedBonus"); } catch (err) { console.error(err); }
});
$("daily-bonus-button").addEventListener("click", async () => {
    if (!connection) return;
    try { await connection.invoke("ClaimDailyBonus"); } catch (err) { console.error(err); }
});

function registerHandlers() {
    // сервер присылает наши данные после входа
    connection.on("Welcome", (info) => {
        myId = info.connectionId;
        myName = info.name;
        myBalance = info.balance;
        myAvatar = info.avatar || myAvatar;
        isModerator = !!info.isModerator;
        setJoinBusy(false);
        const btn = $("join-button");
        btn.classList.add("done");
        btn.querySelector(".lbl").textContent = "Готово ✓";
        renderBalance();
        renderBonusStatus(info.bonus);
        sfx("win");
        setTimeout(() => {
            // если уже вернулись в комнату (возврат из правил) — не выкидываем в лобби
            if (!roomState && !mineState) showScreen("lobby");
            btn.classList.remove("done");
            btn.querySelector(".lbl").textContent = "Войти →";
        }, 450);
    });

    connection.on("Banned", () => {
        setJoinBusy(false);
        fieldError("name-field", true);
        joinStatus.className = "status error";
        joinStatus.textContent = "Вы забанены на этом сайте и не можете войти.";
    });

    // гостевой снимок: онлайн и аватары на экране входа
    connection.on("LobbyPreview", (snapshot) => renderJoinPreview(snapshot));

    // лента последних побед (в т.ч. гостям на экране входа)
    connection.on("WinFeed", (entries) => renderWinFeed(entries));

    // бонус зачислен
    connection.on("BonusClaimed", (info) => {
        myBalance = info.balance;
        renderBalance();
        renderBonusStatus(info.bonus);
        showToast(`Бонус +${info.amount} монет зачислен! 🪙`, "ok");
        coinFly($("bonus-card"), 6);
        const card = $("bonus-card");
        card.classList.remove("claimed-flash");
        void card.offsetWidth;
        card.classList.add("claimed-flash");
    });
    connection.on("BonusDenied", (message) => showToast(message, "warn"));

    // лобби: комнаты + пользователи + лидеры
    connection.on("LobbyUpdated", (snapshot) => {
        lobbyState = snapshot;
        lobbySnapshotAt = Date.now();
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
        lastRoomPassword = null;
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
        sfx("err");
        const cell = document.querySelector(`#mine-field .mcell[data-index="${info.index}"]`);
        if (cell) {
            cell.classList.add("boom");
            setTimeout(() => cell.classList.remove("boom"), 700);
        }
    });

    connection.on("MinePoints", (info) => {
        sfx("tick");
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
        const iWonAny = result.winnerId === myId;
        sfx(iWonAny ? "win" : "pop");
        if (iWonAny && (result.payout > 0 || result.sapperPayout > 0 || result.terroristPayout > 0))
            setTimeout(() => coinFly($("mine-field-wrap"), 8), 300);
        if (result.isDraw) {
            showBanner("Ничья!", "Сапёр: ничья — ставки возвращены.");
        } else if (result.isCashOut) {
            // банк разделён: сапёр забрал долю и ушёл, террористу — остаток
            const iWon = result.winnerId === myId;
            showBanner(iWon ? "Победа! 🎉" : `Победа за ${result.winnerName}!`,
                `Сапёр забрал ${result.sapperPayout}💰 и ушёл с поля, террористу ${result.terroristPayout}💰 за риск.` +
                (iWon ? " Ваш выигрыш зачислен на баланс." : " Реванш?"));
            confetti(iWon ? 220 : 70);
        } else if (result.winnerId === myId) {
            showBanner("Победа! 🎉", result.payout > 0
                ? `Вы получаете ${result.payout} монет из банка (комиссия хаба 5%).`
                : "Поле разминировано — рекорд записан!");
            confetti(220);
        } else if (result.winnerName) {
            showBanner(`Победа за ${result.winnerName}!`, solo
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
        // неверный пароль модератора — shake поля и возврат формы
        if (message && message.indexOf("модератора") !== -1 && screens.join.classList.contains("active")) {
            fieldError("mod-pass-field", true);
            setJoinBusy(false);
            joinStatus.className = "status error";
            joinStatus.textContent = message;
            return;
        }
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
            sfx("pop");
        } else {
            const iWon = result.winner === mySide;
            sfx(iWon ? "win" : "pop");
            if (iWon) setTimeout(() => coinFly($("board"), 8), 300);
            const title = iWon ? "Победа! 🎉" : `Победа за ${result.winnerName}!`;
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
        if (myId) connection.invoke("Join", myName, myModPassword, myAvatar);
        else connection.invoke("WatchLobby").then(renderJoinPreview).catch(() => {});
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
let lastRoomPassword = null;   // пароль, с которым мы вошли в текущую комнату (для возврата из правил)

$("room-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!connection || !pendingRoomId) return;
    const password = $("room-enter-password-input").value;
    lastRoomPassword = password;
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
    try { await connection.invoke("PlaceBet", side, amount); sfx("coin"); } catch (err) { console.error(err); }
}
$("bet-x").addEventListener("click", () => placeBet("X"));
$("bet-o").addEventListener("click", () => placeBet("O"));

cells.forEach((cell) => {
    cell.addEventListener("click", async () => {
        if (!connection || cell.disabled) return;
        sfx("tick");
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
        li.className = "room-item" + (r.inGame ? " room-live" : "");

        const isMine = r.gameType === "minesweeper";
        const tag = isMine
            ? `<span class="game-tag">💣 ${mineModeLabel(r.mineMode)} · ${mineDiffLabel(r.mineDifficulty)}</span>`
            : `<span class="game-tag">✕◯</span>`;

        const info = document.createElement("div");
        info.className = "room-info";
        info.innerHTML =
            `<div class="room-name">${r.inGame ? '<span class="room-live-dot"></span>' : ""}${r.hasPassword ? "🔒 " : ""}${escapeHtml(r.name)} ${tag} ${r.inGame ? '<span class="live">идёт игра</span>' : ""}</div>` +
            `<div class="room-sub">хост: ${escapeHtml(r.hostName)} · 🎮: ${r.playersCount} · 👁️: ${r.spectatorsCount}</div>` +
            (isMine
                ? (r.mineBank > 0 ? `<div class="room-bank">🏦 банк: ${r.mineBank}💰</div>` : "")
                : (r.potX + r.potO > 0 ? `<div class="room-bank">🏦 банк ставок: ${r.potX + r.potO}💰</div>` : "")) +
            (r.idleDeleteSeconds > 0
                ? `<div class="room-idle" data-idle="${r.idleDeleteSeconds}">⏳ пустая — удалится через <b>${formatTime(r.idleDeleteSeconds)}</b></div>`
                : "");

        // Live Room Card: аватары тех, кто уже в комнате
        if (r.avatars && r.avatars.length) {
            const avs = document.createElement("div");
            avs.className = "room-avatars";
            r.avatars.forEach((emoji) => {
                const av = document.createElement("span");
                av.className = "p-av";
                av.textContent = emoji;
                avs.appendChild(av);
            });
            li.appendChild(avs);
        }

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
        name.textContent = `${p.isModerator ? "🛡 " : ""}${p.name}`;

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

// локальный отсчёт таймеров удаления пустых комнат между снимками лобби
setInterval(() => {
    if (!lobbyState || !screens.lobby.classList.contains("active")) return;
    const passed = Math.floor((Date.now() - lobbySnapshotAt) / 1000);
    document.querySelectorAll("#rooms-list .room-idle").forEach((el) => {
        const left = Math.max(0, Number(el.dataset.idle) - passed);
        const b = el.querySelector("b");
        if (b) b.textContent = left > 0 ? formatTime(left) : "удаляется…";
        el.classList.toggle("urgent", left > 0 && left <= 60);
    });
}, 1000);

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

    // асим-риск: кнопка «Забрать очки» — после первого успешного открытия
    const canCashOut = s.mode === "asym" && myTurn && !s.isPlacing && !s.isFinished && (s.asymClicks || 0) > 0;
    $("mine-cashout-button").hidden = !canCashOut;
    if (canCashOut) {
        const n = s.cashOutPayout;
        const word = n % 10 === 1 && n % 100 !== 11 ? "монету"
            : [2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100) ? "монеты" : "монет";
        $("mine-cashout-button").textContent = n > 0
            ? `💰 Забрать ${n} ${word}`
            : "💰 Забрать очки (пока 0💰)";
    }
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
        if (s.mode === "asym") {
            status.innerHTML = myTurn
                ? `<b>Ваш ход!</b> Клик №${(s.asymClicks || 0) + 1} · забрать сейчас: <b>${s.cashOutPayout}💰</b>. Чем дальше — тем больше доля банка, но мина заберёт всё.`
                : `<b>${escapeHtml(s.turnName)}</b> рискует: открыто клеток — ${s.asymClicks || 0}, может забрать ${s.cashOutPayout}💰…`;
        } else {
            status.innerHTML = s.mode === "solo"
                ? "Левый клик — открыть, правый — флажок. Первый ход безопасный."
                : myTurn
                    ? "<b>Ваш ход!</b> Левый клик — открыть, правый — флажок."
                    : `Ходит <b>${escapeHtml(s.turnName)}</b>…`;
        }
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
        card.innerHTML = `${role} ${p.avatar || "😎"} ${escapeHtml(p.name)} — <b>${p.score}</b>` + (p.isOut ? " 💥" : "");
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
            li.innerHTML = `<span>${p.avatar || "😎"} ${escapeHtml(p.name)}${p.isOut ? " 💥" : ""}${p.isReady && !s.isStarted ? " ✔" : ""}</span>` +
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
            li.innerHTML = `<span>👁 ${p.avatar || "😎"} ${escapeHtml(p.name)}${p.isModerator ? " 🛡" : ""}</span>` +
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
    sfx("tick");
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

$("mine-cashout-button").addEventListener("click", async () => {
    if (!connection) return;
    const payout = mineState ? mineState.cashOutPayout : 0;
    if (!confirm(`Забрать ${payout}💰 и закончить партию? Остаток банка уйдёт террористу.`)) return;
    try { await connection.invoke("MineCashOut"); } catch (err) { console.error(err); }
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
    try { await connection.invoke("MineBet", target, amount); sfx("coin"); } catch (err) { console.error(err); }
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
        li.innerHTML = `<span>${p.avatar || "😎"} ${escapeHtml(titleFn(p))}${p.isModerator ? " 🛡" : ""}</span>` +
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
        const panels = Array.from(document.querySelectorAll(".screen.active .panel, .screen.active .join-card, .screen.active .preview-card"))
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

// ============================================================ звёзды с параллаксом
// Слой фона из превью: три глубины звёзд, медленно дрейфуют и реагируют
// на курсор. Кнопка ✨ гасит слой вместе с aurora и орбитами.

(function starfield() {
    const cvs = $("stars");
    if (!cvs) return;
    const sctx = cvs.getContext("2d");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let stars = [];
    let W = 0, H = 0;
    let mx = 0, my = 0;         // сглаженный параллакс курсора

    function rebuild() {
        W = cvs.width = window.innerWidth;
        H = cvs.height = window.innerHeight;
        const count = Math.min(160, Math.floor(W * H / 9000));
        stars = Array.from({ length: count }, () => ({
            x: Math.random() * W,
            y: Math.random() * H,
            z: 0.3 + Math.random() * 0.7,           // глубина: параллакс и яркость
            r: 0.4 + Math.random() * 1.3,
            tw: Math.random() * Math.PI * 2,        // фаза мерцания
            vx: (Math.random() - 0.5) * 0.05
        }));
        draw(performance.now());
    }

    let targetMx = 0, targetMy = 0;
    window.addEventListener("mousemove", (e) => {
        targetMx = (e.clientX / window.innerWidth - 0.5) * 2;
        targetMy = (e.clientY / window.innerHeight - 0.5) * 2;
    });

    function draw(time) {
        sctx.clearRect(0, 0, W, H);
        mx += (targetMx - mx) * 0.04;
        my += (targetMy - my) * 0.04;
        stars.forEach((s) => {
            const twinkle = 0.55 + Math.sin(time / 1400 + s.tw) * 0.35;
            const px = s.x - mx * 14 * s.z;
            const py = s.y - my * 10 * s.z;
            sctx.beginPath();
            sctx.arc(px, py, s.r * s.z + 0.3, 0, Math.PI * 2);
            sctx.fillStyle = `rgba(210,225,255,${(0.25 + s.z * 0.5) * twinkle})`;
            sctx.fill();
        });
    }

    function loop(time) {
        if (fxOn && !document.hidden) {
            stars.forEach((s) => {
                s.x += s.vx * s.z;
                if (s.x < -4) s.x = W + 4;
                if (s.x > W + 4) s.x = -4;
            });
            draw(time);
        }
        requestAnimationFrame(loop);
    }

    window.addEventListener("resize", rebuild);
    rebuild();
    if (!reduceMotion) requestAnimationFrame(loop);
})();

// ============================================================ Text Scramble
// Заголовок PlayHub «расшифровывается» при загрузке и периодически.

(function scrambleTitle() {
    const el = $("scramble-title");
    if (!el) return;
    const target = el.textContent;
    const glyphs = "!<>-_\\/[]{}—=+*^?#$%&";
    let busy = false;

    function scramble() {
        if (busy || !fxOn || document.hidden || !screens.join.classList.contains("active")) return;
        busy = true;
        const dur = 900;
        const start = performance.now();
        function step() {
            const t = Math.min(1, (performance.now() - start) / dur);
            const solved = Math.floor(t * target.length);
            let out = "";
            for (let i = 0; i < target.length; i++) {
                out += i < solved ? target[i] : glyphs[Math.floor(Math.random() * glyphs.length)];
            }
            el.textContent = out;
            if (t < 1 && fxOn && !document.hidden) setTimeout(step, 40);
            else { el.textContent = target; busy = false; }
        }
        step();
    }

    scramble();
    setInterval(scramble, 9000);
})();

// ============================================================ playable preview
// Крестики-нолики против бота прямо на экране входа — без регистрации.
// Бот играет сильно (минимакс с ограничением глубины), но иногда ошибается,
// чтобы у гостя был шанс выиграть.

(function playablePreview() {
    const boardEl = $("pg-board");
    const statusEl = $("pg-status");
    if (!boardEl) return;

    const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    let grid = Array(9).fill("");
    let over = false;
    let botThinking = false;
    const score = { w: 0, d: 0, l: 0 };
    try {
        const saved = JSON.parse(localStorage.getItem("ph-pg-score") || "null");
        if (saved && typeof saved.w === "number") Object.assign(score, saved);
    } catch (e) { /* свежий счёт */ }

    const cellEls = [];
    for (let i = 0; i < 9; i++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "g-cell";
        btn.dataset.index = i;
        btn.setAttribute("aria-label", `Клетка ${i + 1}`);
        btn.addEventListener("click", () => humanMove(i));
        boardEl.appendChild(btn);
        cellEls.push(btn);
    }

    function winnerOf(g) {
        for (const line of LINES) {
            const [a, b, c] = line;
            if (g[a] && g[a] === g[b] && g[a] === g[c]) return { mark: g[a], line };
        }
        return g.every((v) => v) ? { mark: "draw", line: [] } : null;
    }

    function paint(winLine) {
        grid.forEach((v, i) => {
            const el = cellEls[i];
            el.textContent = v === "X" ? "✕" : v === "O" ? "◯" : "";
            el.className = "g-cell" + (v ? " " + v.toLowerCase() : "") +
                (winLine && winLine.includes(i) ? " win" : "");
            el.disabled = over || botThinking || v !== "";
        });
    }

    function renderScore() {
        $("pg-w").textContent = score.w;
        $("pg-d").textContent = score.d;
        $("pg-l").textContent = score.l;
        localStorage.setItem("ph-pg-score", JSON.stringify(score));
    }

    function finish(result) {
        over = true;
        if (result.mark === "X") {
            score.w++;
            statusEl.textContent = "Победа! Теперь за настоящими монетами →";
            statusEl.className = "g-status win";
            sfx("win");
        } else if (result.mark === "O") {
            score.l++;
            statusEl.textContent = "Бот победил. Реванш?";
            statusEl.className = "g-status lose";
            sfx("err");
        } else {
            score.d++;
            statusEl.textContent = "Ничья! Достойно 🤝";
            statusEl.className = "g-status";
            sfx("pop");
        }
        renderScore();
        paint(result.line);
    }

    // минимакс: X максимизирует, O минимизирует; глубина ограничена 6
    function minimax(g, turn, depth) {
        const res = winnerOf(g);
        if (res) return res.mark === "X" ? 10 - depth : res.mark === "O" ? depth - 10 : 0;
        if (depth >= 6) return 0;
        let best = turn === "X" ? -Infinity : Infinity;
        for (let i = 0; i < 9; i++) {
            if (g[i]) continue;
            g[i] = turn;
            const val = minimax(g, turn === "X" ? "O" : "X", depth + 1);
            g[i] = "";
            best = turn === "X" ? Math.max(best, val) : Math.min(best, val);
        }
        return best;
    }

    function botMove() {
        const empty = grid.map((v, i) => v ? -1 : i).filter((i) => i >= 0);
        if (!empty.length) return;
        let pick;
        if (Math.random() < 0.22) {
            // осечка бота: случайная клетка — шанс гостя
            pick = empty[Math.floor(Math.random() * empty.length)];
        } else {
            let best = Infinity;
            pick = empty[0];
            for (const i of empty) {
                grid[i] = "O";
                const val = minimax(grid, "X", 0);
                grid[i] = "";
                if (val < best) { best = val; pick = i; }
            }
        }
        grid[pick] = "O";
        botThinking = false;
        sfx("pop");
        const res = winnerOf(grid);
        if (res) finish(res);
        else { statusEl.textContent = "Твой ход ✕"; statusEl.className = "g-status"; paint(); }
    }

    function humanMove(i) {
        if (over || botThinking || grid[i]) return;
        grid[i] = "X";
        sfx("tick");
        const res = winnerOf(grid);
        if (res) { finish(res); return; }
        botThinking = true;
        statusEl.textContent = "Бот думает…";
        paint();
        setTimeout(botMove, 420 + Math.random() * 320);
    }

    function newGame() {
        grid = Array(9).fill("");
        over = false;
        botThinking = false;
        statusEl.textContent = "Твой ход ✕";
        statusEl.className = "g-status";
        paint();
    }

    $("pg-new").addEventListener("click", () => { newGame(); sfx("tick"); });
    $("pg-reset-score").addEventListener("click", () => {
        score.w = score.d = score.l = 0;
        renderScore();
        sfx("tick");
    });

    renderScore();
    newGame();
})();
