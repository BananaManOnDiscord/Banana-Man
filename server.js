const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;


/* ==========================================
   DATABASE
========================================== */

if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is missing!");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


/* ==========================================
   WEBSITE
========================================== */

const publicFolder =
    path.join(__dirname, "public");

app.use(express.json());

app.use(
    express.static(publicFolder)
);

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            publicFolder,
            "index.html"
        )
    );

});


/* ==========================================
   MARKET
========================================== */

let price = 0.00004269;

const STARTING_CASH = 10000;


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
   SESSIONS
========================================== */

const sessions = new Map();


/* ==========================================
   PASSWORD HASH
========================================== */

function hashPassword(password) {

    return crypto
        .createHash("sha256")
        .update(password)
        .digest("hex");

}


/* ==========================================
   DATABASE SETUP
========================================== */

async function setupDatabase() {

    await pool.query(`

        CREATE TABLE IF NOT EXISTS users (

            id SERIAL PRIMARY KEY,

            username VARCHAR(20)
                UNIQUE NOT NULL,

            email VARCHAR(255)
                NOT NULL,

            password_hash TEXT
                NOT NULL,

            cash DOUBLE PRECISION
                NOT NULL DEFAULT 10000,

            bananas DOUBLE PRECISION
                NOT NULL DEFAULT 0,

            starting_portfolio DOUBLE PRECISION
                NOT NULL DEFAULT 10000,

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP

        );

    `);


    await pool.query(`

        CREATE TABLE IF NOT EXISTS achievements (

            id SERIAL PRIMARY KEY,

            user_id INTEGER
                REFERENCES users(id)
                ON DELETE CASCADE,

            achievement VARCHAR(100)
                NOT NULL,

            unlocked_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP,

            UNIQUE(
                user_id,
                achievement
            )

        );

    `);


    console.log(
        "🍌 Database tables ready."
    );

}


/* ==========================================
   GET USER
========================================== */

async function getUserByUsername(
    username
) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM users
            WHERE LOWER(username) =
                  LOWER($1)
            `,
            [username]
        );

    return result.rows[0] || null;

}


/* ==========================================
   GET ACHIEVEMENTS
========================================== */

async function getAchievements(
    userId
) {

    const result =
        await pool.query(
            `
            SELECT achievement
            FROM achievements
            WHERE user_id = $1
            `,
            [userId]
        );


    return result.rows.map(
        row => row.achievement
    );

}


/* ==========================================
   REGISTER
========================================== */

app.post(
    "/api/register",
    async (req, res) => {

        try {

            const {
                username,
                email,
                password
            } = req.body;


            if (
                typeof username !== "string" ||
                !/^[a-zA-Z0-9_]{3,20}$/.test(
                    username
                )
            ) {

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
                    error:
                        "Enter a fake email."
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


            const existing =
                await getUserByUsername(
                    username
                );


            if (existing) {

                return res.status(400).json({
                    error:
                        "That username already exists."
                });

            }


            const passwordHash =
                hashPassword(password);


            const result =
                await pool.query(
                    `
                    INSERT INTO users
                    (
                        username,
                        email,
                        password_hash
                    )
                    VALUES
                    ($1, $2, $3)
                    RETURNING *
                    `,
                    [
                        username,
                        email,
                        passwordHash
                    ]
                );


            const user =
                result.rows[0];


            const token =
                crypto
                    .randomBytes(32)
                    .toString("hex");


            sessions.set(
                token,
                user.id
            );


            res.json({

                token,

                username:
                    user.username,

                cash:
                    user.cash,

                bananas:
                    user.bananas,

                achievements: []

            });


        } catch (error) {

            console.error(
                "REGISTER ERROR:",
                error
            );


            res.status(500).json({
                error:
                    "Database error."
            });

        }

    }
);


/* ==========================================
   LOGIN
========================================== */

app.post(
    "/api/login",
    async (req, res) => {

        try {

            const {
                username,
                password
            } = req.body;


            const user =
                await getUserByUsername(
                    String(username || "")
                );


            if (
                !user ||
                user.password_hash !==
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
                crypto
                    .randomBytes(32)
                    .toString("hex");


            sessions.set(
                token,
                user.id
            );


            const achievements =
                await getAchievements(
                    user.id
                );


            res.json({

                token,

                username:
                    user.username,

                cash:
                    user.cash,

                bananas:
                    user.bananas,

                achievements

            });


        } catch (error) {

            console.error(
                "LOGIN ERROR:",
                error
            );


            res.status(500).json({
                error:
                    "Database error."
            });

        }

    }
);


/* ==========================================
   GET USER FROM SOCKET
========================================== */

async function getUserFromSocket(
    socket
) {

    if (!socket.userToken)
        return null;


    const userId =
        sessions.get(
            socket.userToken
        );


    if (!userId)
        return null;


    const result =
        await pool.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            `,
            [userId]
        );


    return result.rows[0] || null;

}


/* ==========================================
   SAVE USER
========================================== */

async function saveUser(user) {

    await pool.query(
        `
        UPDATE users

        SET
            cash = $1,
            bananas = $2

        WHERE id = $3
        `,
        [
            user.cash,
            user.bananas,
            user.id
        ]
    );

}


/* ==========================================
   AWARD ACHIEVEMENT
========================================== */

async function award(
    userId,
    achievementId
) {

    if (!ACHIEVEMENTS[achievementId])
        return false;


    const result =
        await pool.query(
            `
            INSERT INTO achievements
            (
                user_id,
                achievement
            )

            VALUES
            ($1, $2)

            ON CONFLICT
            (
                user_id,
                achievement
            )

            DO NOTHING

            RETURNING achievement
            `,
            [
                userId,
                achievementId
            ]
        );


    return result.rowCount > 0;

}


/* ==========================================
   CHECK ACHIEVEMENTS
========================================== */

async function checkAchievements(
    user
) {

    const unlocked = [];


    if (
        user.bananas > 0 &&
        await award(
            user.id,
            "firstBanana"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.firstBanana
        );

    }


    if (
        user.bananas >= 1000000 &&
        await award(
            user.id,
            "bananaWhale"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.bananaWhale
        );

    }


    const portfolio =
        user.cash +
        user.bananas * price;


    if (
        portfolio >= 1000000 &&
        await award(
            user.id,
            "millionaire"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.millionaire
        );

    }


    if (
        portfolio >=
            user.starting_portfolio * 2 &&
        await award(
            user.id,
            "profit100"
        )
    ) {

        unlocked.push(
            ACHIEVEMENTS.profit100
        );

    }


    if (
        portfolio <=
            user.starting_portfolio * 0.5 &&
        await award(
            user.id,
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
   ONLINE PLAYERS
========================================== */

const onlineSockets =
    new Set();


function broadcast(data) {

    const message =
        JSON.stringify(data);


    wss.clients.forEach(
        client => {

            if (
                client.readyState ===
                WebSocket.OPEN
            ) {

                client.send(
                    message
                );

            }

        }
    );

}


/* ==========================================
   SEND PORTFOLIO
========================================== */

async function sendPortfolio(
    socket,
    user
) {

    const achievements =
        await getAchievements(
            user.id
        );


    const portfolio =
        user.cash +
        user.bananas * price;


    socket.send(
        JSON.stringify({

            type:
                "portfolio",

            username:
                user.username,

            cash:
                user.cash,

            bananas:
                user.bananas,

            portfolio,

            achievements

        })
    );

}


/* ==========================================
   LEADERBOARD
========================================== */

async function getLeaderboard() {

    const result =
        await pool.query(
            `
            SELECT
                username,
                cash,
                bananas,
                starting_portfolio

            FROM users
            `
        );


    const leaderboard =
        result.rows
            .map(user => {

                const portfolio =
                    user.cash +
                    user.bananas *
                    price;


                return {

                    username:
                        user.username,

                    portfolio,

                    bananas:
                        user.bananas,

                    profit:
                        portfolio -
                        user.starting_portfolio

                };

            })
            .sort(
                (a, b) =>
                    b.portfolio -
                    a.portfolio
            )
            .slice(0, 50);


    return leaderboard;

}


async function broadcastLeaderboard() {

    const leaderboard =
        await getLeaderboard();


    broadcast({

        type:
            "leaderboard",

        leaderboard

    });

}


/* ==========================================
   LEADERBOARD API
========================================== */

app.get(
    "/api/leaderboard",
    async (req, res) => {

        try {

            res.json(
                await getLeaderboard()
            );

        } catch {

            res.status(500).json({
                error:
                    "Database error."
            });

        }

    }
);


/* ==========================================
   WEBSOCKET
========================================== */

wss.on(
    "connection",
    socket => {

        onlineSockets.add(
            socket
        );


        socket.send(
            JSON.stringify({

                type:
                    "market",

                price

            })
        );


        broadcast({

            type:
                "players",

            count:
                onlineSockets.size

        });


        socket.on(
            "message",
            async raw => {

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
                   AUTHENTICATE
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


                    const user =
                        await getUserFromSocket(
                            socket
                        );


                    if (!user)
                        return;


                    await sendPortfolio(
                        socket,
                        user
                    );


                    await broadcastLeaderboard();

                }


                /* =========================
                   BUY
                ========================= */

                if (
                    data.type ===
                    "buy"
                ) {

                    const user =
                        await getUserFromSocket(
                            socket
                        );


                    if (!user)
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
                        amount *
                        price;


                    if (
                        cost >
                        user.cash
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


                    user.cash -=
                        cost;

                    user.bananas +=
                        amount;


                    await saveUser(
                        user
                    );


                    const unlocked =
                        await checkAchievements(
                            user
                        );


                    broadcast({

                        type:
                            "trade",

                        message:
                            "🟢 " +
                            user.username +
                            " bought " +
                            Math.floor(
                                amount
                            ).toLocaleString() +
                            " BANANA"

                    });


                    for (
                        const achievement
                        of unlocked
                    ) {

                        socket.send(
                            JSON.stringify({

                                type:
                                    "achievement",

                                achievement

                            })
                        );

                    }


                    await sendPortfolio(
                        socket,
                        user
                    );


                    await broadcastLeaderboard();

                }


                /* =========================
                   SELL
                ========================= */

                if (
                    data.type ===
                    "sell"
                ) {

                    const user =
                        await getUserFromSocket(
                            socket
                        );


                    if (!user)
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
                        user.bananas
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


                    user.bananas -=
                        amount;

                    user.cash +=
                        amount *
                        price;


                    await saveUser(
                        user
                    );


                    const unlocked =
                        await checkAchievements(
                            user
                        );


                    broadcast({

                        type:
                            "trade",

                        message:
                            "🔴 " +
                            user.username +
                            " sold " +
                            Math.floor(
                                amount
                            ).toLocaleString() +
                            " BANANA"

                    });


                    for (
                        const achievement
                        of unlocked
                    ) {

                        socket.send(
                            JSON.stringify({

                                type:
                                    "achievement",

                                achievement

                            })
                        );

                    }


                    await sendPortfolio(
                        socket,
                        user
                    );


                    await broadcastLeaderboard();

                }

            }
        );


        socket.on(
            "close",
            () => {

                onlineSockets.delete(
                    socket
                );


                broadcast({

                    type:
                        "players",

                    count:
                        onlineSockets.size

                });

            }
        );

    }
);


/* ==========================================
   MARKET TICK
========================================== */

setInterval(
    async () => {

        const movement =
            (
                Math.random() -
                0.48
            ) * 0.045;


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


        await broadcastLeaderboard();

    },
    900
);


/* ==========================================
   START
========================================== */

async function start() {

    try {

        await setupDatabase();


        server.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    "🍌 Banana Coin server running on port " +
                    PORT
                );

            }
        );

    } catch (error) {

        console.error(
            "❌ Failed to start:",
            error
        );

        process.exit(1);

    }

}


start();
