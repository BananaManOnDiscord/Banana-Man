const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

app.use(express.json());

const publicFolder = path.join(__dirname, "public");

app.use(express.static(publicFolder));

app.get("/", (req, res) => {
    res.sendFile(path.join(publicFolder, "index.html"));
});


/* ==========================================
   BANANA MARKET
========================================== */

let price = 0.00004269;

const STARTING_CASH = 10000;


/* ==========================================
   ACCOUNTS
========================================== */

const accounts = new Map();

const sessions = new Map();

const sockets = new Map();


/* ==========================================
   ACHIEVEMENTS
========================================== */

const ACHIEVEMENTS = {

    firstBanana: {
        name: "🍌 First Banana",
        description: "Buy your first BANANA"
    },

    bananaWhale: {
        name: "🐋 Banana Whale",
        description: "Own 1,000,000 BANANA"
    },

    millionaire: {
        name: "💰 Banana Millionaire",
        description: "Reach $1,000,000"
    },

    diamondHands: {
        name: "💎 Diamond Hands",
        description: "Survive a 50% market crash"
    },

    profit100: {
        name: "📈 To The Moon",
        description: "Make 100% profit"
    },

    financialDisaster: {
        name: "💀 Financial Disaster",
        description: "Lose 50% of your starting portfolio"
    }

};


/* ==========================================
   PASSWORD HASHING
========================================== */

function hashPassword(password) {

    return crypto
        .createHash("sha256")
        .update(password)
        .digest("hex");

}


/* ==========================================
   USERNAME VALIDATION
========================================== */

function validUsername(username) {

    return (
        typeof username === "string" &&
        /^[a-zA-Z0-9_]{3,20}$/.test(username)
    );

}


/* ==========================================
   ACCOUNT API
========================================== */

app.post("/api/register", (req, res) => {

    const {
        username,
        email,
        password
    } = req.body;


    if (!validUsername(username)) {

        return res.status(400).json({
            error:
                "Username must be 3-20 letters, numbers or underscores."
        });

    }


    if (
        typeof email !== "string" ||
        email.length < 3
    ) {

        return res.status(400).json({
            error: "Enter a fake email."
        });

    }


    if (
        typeof password !== "string" ||
        password.length < 4
    ) {

        return res.status(400).json({
            error:
                "Password must be at least 4 characters."
        });

    }


    const key =
        username.toLowerCase();


    if (accounts.has(key)) {

        return res.status(400).json({
            error:
                "That username already exists."
        });

    }


    const account = {

        username,

        email,

        passwordHash:
            hashPassword(password),

        cash:
            STARTING_CASH,

        bananas: 0,

        startingPortfolio:
            STARTING_CASH,

        achievements: [],

        createdAt:
            Date.now()

    };


    accounts.set(
        key,
        account
    );


    const token =
        crypto.randomBytes(32).toString("hex");


    sessions.set(
        token,
        key
    );


    res.json({

        token,

        username:

            account.username,

        cash:

            account.cash,

        bananas:

            account.bananas,

        achievements:

            account.achievements

    });

});


/* ==========================================
   LOGIN
========================================== */

app.post("/api/login", (req, res) => {

    const {
        username,
        password
    } = req.body;


    const key =
        String(username || "")
            .toLowerCase();


    const account =
        accounts.get(key);


    if (
        !account ||
        account.passwordHash !==
        hashPassword(
            String(password || "")
        )
    ) {

        return res.status(401).json({
            error:
                "Wrong username or password."
        });

    }


    const token =
        crypto.randomBytes(32).toString("hex");


    sessions.set(
        token,
        key
    );


    res.json({

        token,

        username:
            account.username,

        cash:
            account.cash,

        bananas:
            account.bananas,

        achievements:
            account.achievements

    });

});


/* ==========================================
   LEADERBOARD API
========================================== */

app.get("/api/leaderboard", (req, res) => {

    const leaderboard =
        [...accounts.values()]
            .map(account => {

                const portfolio =
                    account.cash +
                    account.bananas * price;

                return {

                    username:
                        account.username,

                    portfolio,

                    bananas:
                        account.bananas,

                    profit:
                        portfolio -
                        account.startingPortfolio,

                    achievements:
                        account.achievements.length

                };

            })
            .sort(
                (a, b) =>
                    b.portfolio -
                    a.portfolio
            )
            .slice(0, 50);


    res.json(leaderboard);

});


/* ==========================================
   GET ACCOUNT
========================================== */

function getAccount(socket) {

    const token =
        socket.userToken;

    const key =
        sessions.get(token);

    if (!key)
        return null;

    return accounts.get(key);

}


/* ==========================================
   ACHIEVEMENT CHECK
========================================== */

function award(account, id) {

    if (
        account.achievements.includes(id)
    ) {
        return false;
    }


    if (!ACHIEVEMENTS[id])
        return false;


    account.achievements.push(id);

    return true;

}


function checkAchievements(account) {

    const unlocked = [];


    if (
        account.bananas > 0 &&
        award(
            account,
            "firstBanana"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.firstBanana
        );

    }


    if (
        account.bananas >= 1000000 &&
        award(
            account,
            "bananaWhale"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.bananaWhale
        );

    }


    const portfolio =
        account.cash +
        account.bananas * price;


    if (
        portfolio >= 1000000 &&
        award(
            account,
            "millionaire"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.millionaire
        );

    }


    if (
        portfolio >=
        account.startingPortfolio * 2 &&
        award(
            account,
            "profit100"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.profit100
        );

    }


    if (
        portfolio <=
        account.startingPortfolio * 0.5 &&
        award(
            account,
            "financialDisaster"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.financialDisaster
        );

    }


    return unlocked;

}


/* ==========================================
   BROADCAST
========================================== */

function broadcast(data) {

    const message =
        JSON.stringify(data);


    wss.clients.forEach(
        client => {

            if (
                client.readyState ===
                WebSocket.OPEN
            ) {

                client.send(message);

            }

        }
    );

}


/* ==========================================
   SEND PORTFOLIO
========================================== */

function sendPortfolio(
    socket,
    account
) {

    if (
        socket.readyState !==
        WebSocket.OPEN
    ) {
        return;
    }


    const portfolio =
        account.cash +
        account.bananas * price;


    socket.send(
        JSON.stringify({

            type:
                "portfolio",

            username:
                account.username,

            cash:
                account.cash,

            bananas:
                account.bananas,

            portfolio,

            achievements:
                account.achievements

        })
    );

}


/* ==========================================
   WEBSOCKET
========================================== */

wss.on(
    "connection",
    socket => {

        socket.send(
            JSON.stringify({

                type:
                    "market",

                price

            })
        );


        socket.on(
            "message",
            raw => {

                let data;


                try {

                    data =
                        JSON.parse(
                            raw.toString()
                        );

                } catch {

                    return;

                }


                /* =========================
                   LOGIN TOKEN
                ========================= */

                if (
                    data.type ===
                    "authenticate"
                ) {

                    if (
                        !sessions.has(
                            data.token
                        )
                    ) {

                        socket.send(
                            JSON.stringify({
                                type:
                                    "error",
                                message:
                                    "Invalid login."
                            })
                        );

                        return;

                    }


                    socket.userToken =
                        data.token;


                    const account =
                        getAccount(socket);


                    sockets.set(
                        account.username,
                        socket
                    );


                    sendPortfolio(
                        socket,
                        account
                    );


                    broadcast({
                        type:
                            "players",
                        count:
                            sockets.size
                    });

                }


                /* =========================
                   BUY
                ========================= */

                if (
                    data.type ===
                    "buy"
                ) {

                    const account =
                        getAccount(socket);


                    if (!account)
                        return;


                    const amount =
                        Number(
                            data.amount
                        );


                    if (
                        !Number.isFinite(
                            amount
                        ) ||
                        amount <= 0
                    ) {
                        return;
                    }


                    const cost =
                        amount * price;


                    if (
                        cost >
                        account.cash
                    ) {

                        socket.send(
                            JSON.stringify({

                                type:
                                    "error",

                                message:
                                    "Not enough fake money! 🍌"

                            })
                        );

                        return;

                    }


                    account.cash -=
                        cost;

                    account.bananas +=
                        amount;


                    const unlocked =
                        checkAchievements(
                            account
                        );


                    broadcast({

                        type:
                            "trade",

                        message:
                            "🟢 " +
                            account.username +
                            " bought " +
                            Math.floor(
                                amount
                            ).toLocaleString() +
                            " BANANA"

                    });


                    unlocked.forEach(
                        achievement => {

                            socket.send(
                                JSON.stringify({

                                    type:
                                        "achievement",

                                    achievement

                                })
                            );

                        }
                    );


                    sendPortfolio(
                        socket,
                        account
                    );


                    broadcastLeaderboard();

                }


                /* =========================
                   SELL
                ========================= */

                if (
                    data.type ===
                    "sell"
                ) {

                    const account =
                        getAccount(socket);


                    if (!account)
                        return;


                    const amount =
                        Number(
                            data.amount
                        );


                    if (
                        !Number.isFinite(
                            amount
                        ) ||
                        amount <= 0
                    ) {
                        return;
                    }


                    if (
                        amount >
                        account.bananas
                    ) {

                        socket.send(
                            JSON.stringify({

                                type:
                                    "error",

                                message:
                                    "You don't own that much BANANA!"

                            })
                        );

                        return;

                    }


                    account.bananas -=
                        amount;

                    account.cash +=
                        amount * price;


                    const unlocked =
                        checkAchievements(
                            account
                        );


                    broadcast({

                        type:
                            "trade",

                        message:
                            "🔴 " +
                            account.username +
                            " sold " +
                            Math.floor(
                                amount
                            ).toLocaleString() +
                            " BANANA"

                    });


                    unlocked.forEach(
                        achievement => {

                            socket.send(
                                JSON.stringify({

                                    type:
                                        "achievement",

                                    achievement

                                })
                            );

                        }
                    );


                    sendPortfolio(
                        socket,
                        account
                    );


                    broadcastLeaderboard();

                }

            }
        );


        socket.on(
            "close",
            () => {

                if (
                    socket.userToken
                ) {

                    const account =
                        getAccount(
                            socket
                        );


                    if (
                        account &&
                        sockets.get(
                            account.username
                        ) === socket
                    ) {

                        sockets.delete(
                            account.username
                        );

                    }

                }


                broadcast({

                    type:
                        "players",

                    count:
                        sockets.size

                });

            }
        );

    }
);


/* ==========================================
   MARKET
========================================== */

setInterval(
    () => {

        const movement =
            (Math.random() - 0.48)
            * 0.045;


        price *=
            1 + movement;


        price =
            Math.max(
                price,
                0.00000001
            );


        broadcast({

            type:
                "market",

            price

        });


        /*
           Update portfolios and
           achievements.
        */

        for (
            const account
            of accounts.values()
        ) {

            const portfolio =
                account.cash +
                account.bananas *
                price;


            if (
                portfolio >=
                account.startingPortfolio * 2
            ) {

                award(
                    account,
                    "profit100"
                );

            }

        }


        broadcastLeaderboard();

    },
    900
);


/* ==========================================
   LEADERBOARD BROADCAST
========================================== */

function broadcastLeaderboard() {

    const leaderboard =
        [...accounts.values()]
            .map(account => {

                const portfolio =
                    account.cash +
                    account.bananas *
                    price;


                return {

                    username:
                        account.username,

                    portfolio,

                    bananas:
                        account.bananas,

                    profit:
                        portfolio -
                        account.startingPortfolio,

                    achievements:
                        account.achievements.length

                };

            })
            .sort(
                (a, b) =>
                    b.portfolio -
                    a.portfolio
            )
            .slice(0, 50);


    broadcast({

        type:
            "leaderboard",

        leaderboard

    });

}


/* ==========================================
   SERVER
========================================== */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "🍌 Banana Coin server running on port " +
            PORT
        );

        console.log(
            "📁 Website folder: " +
            publicFolder
        );

    }
);
