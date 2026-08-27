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

const STARTING_CASH = 10000;
let price = 0.00004269;


/* =========================================================
   DATABASE
========================================================= */

if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is missing!");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json());

const publicFolder = path.join(__dirname, "public");

app.use(express.static(publicFolder));

app.get("/", (req, res) => {
    res.sendFile(
        path.join(publicFolder, "index.html")
    );
});

app.get("/admin", (req, res) => {
    res.sendFile(
        path.join(publicFolder, "admin.html")
    );
});


/* =========================================================
   SESSIONS
========================================================= */

const userSessions = new Map();
const adminSessions = new Set();

const onlineSockets = new Set();


function createToken() {
    return crypto
        .randomBytes(32)
        .toString("hex");
}


/* =========================================================
   PASSWORD HASHING
========================================================= */

function hashPassword(password) {
    return crypto
        .createHash("sha256")
        .update(password)
        .digest("hex");
}


/* =========================================================
   DATABASE SETUP
========================================================= */

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
        )
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

            UNIQUE(user_id, achievement)
        )
    `);


    console.log("🍌 Database tables ready.");
}


/* =========================================================
   ACHIEVEMENTS
========================================================= */

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


/* =========================================================
   DATABASE HELPERS
========================================================= */

async function getUserByUsername(username) {

    const result = await pool.query(
        `
        SELECT *
        FROM users
        WHERE LOWER(username) = LOWER($1)
        `,
        [username]
    );

    return result.rows[0] || null;
}


async function getUserById(id) {

    const result = await pool.query(
        `
        SELECT *
        FROM users
        WHERE id = $1
        `,
        [id]
    );

    return result.rows[0] || null;
}


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


async function getAchievements(userId) {

    const result = await pool.query(
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


async function unlockAchievement(
    userId,
    achievementId
) {

    if (!ACHIEVEMENTS[achievementId]) {
        return false;
    }

    const result = await pool.query(
        `
        INSERT INTO achievements
            (user_id, achievement)

        VALUES
            ($1, $2)

        ON CONFLICT
            (user_id, achievement)

        DO NOTHING

        RETURNING id
        `,
        [
            userId,
            achievementId
        ]
    );

    return result.rowCount > 0;
}


/* =========================================================
   ACHIEVEMENT CHECK
========================================================= */

async function checkAchievements(user) {

    const unlocked = [];

    if (
        user.bananas > 0 &&
        await unlockAchievement(
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
        await unlockAchievement(
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
        await unlockAchievement(
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

        await unlockAchievement(
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

        await unlockAchievement(
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


/* =========================================================
   BROADCAST
========================================================= */

function broadcast(data) {

    const message =
        JSON.stringify(data);

    wss.clients.forEach(client => {

        if (
            client.readyState ===
            WebSocket.OPEN
        ) {
            client.send(message);
        }

    });
}


/* =========================================================
   SEND USER PORTFOLIO
========================================================= */

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

            type: "portfolio",

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


/* =========================================================
   REGISTER
========================================================= */

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
                !/^[a-zA-Z0-9_]{3,20}$/
                    .test(username)
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
                        "Enter an email."
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
                        password_hash,
                        cash,
                        bananas,
                        starting_portfolio
                    )

                    VALUES
                    ($1, $2, $3, $4, $5, $6)

                    RETURNING *
                    `,
                    [
                        username,
                        email,
                        passwordHash,
                        STARTING_CASH,
                        0,
                        STARTING_CASH
                    ]
                );


            const user =
                result.rows[0];


            const token =
                createToken();


            userSessions.set(
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


/* =========================================================
   LOGIN
========================================================= */

app.post(
    "/api/login",
    async (req, res) => {

        try {

            const username =
                String(
                    req.body.username || ""
                );

            const password =
                String(
                    req.body.password || ""
                );


            const user =
                await getUserByUsername(
                    username
                );


            if (
                !user ||
                user.password_hash !==
                hashPassword(password)
            ) {

                return res.status(401).json({
                    error:
                        "Wrong username or password."
                });

            }


            const token =
                createToken();


            userSessions.set(
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


/* =========================================================
   USER AUTH
========================================================= */

async function getUserFromSocket(socket) {

    if (!socket.userToken) {
        return null;
    }


    const userId =
        userSessions.get(
            socket.userToken
        );


    if (!userId) {
        return null;
    }


    return await getUserById(
        userId
    );
}


/* =========================================================
   LEADERBOARD
========================================================= */

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


    return result.rows
        .map(user => {

            const portfolio =
                user.cash +
                user.bananas * price;


            return {

                username:
                    user.username,

                cash:
                    user.cash,

                bananas:
                    user.bananas,

                portfolio,

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
}


async function broadcastLeaderboard() {

    try {

        const leaderboard =
            await getLeaderboard();


        broadcast({

            type:
                "leaderboard",

            leaderboard

        });

    } catch (error) {

        console.error(
            "LEADERBOARD ERROR:",
            error
        );

    }
}


/* =========================================================
   PUBLIC LEADERBOARD
========================================================= */

app.get(
    "/api/leaderboard",
    async (req, res) => {

        try {

            res.json(
                await getLeaderboard()
            );

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Database error."
            });

        }

    }
);


/* =========================================================
   ADMIN AUTH
========================================================= */

function requireAdmin(req, res, next) {

    const header =
        req.headers.authorization || "";


    if (
        !header.startsWith(
            "Bearer "
        )
    ) {

        return res.status(401).json({
            error:
                "Admin authentication required."
        });

    }


    const token =
        header.substring(7);


    if (
        !adminSessions.has(token)
    ) {

        return res.status(401).json({
            error:
                "Invalid admin session."
        });

    }


    next();
}


/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
    "/api/admin/login",
    (req, res) => {

        const username =
            String(
                req.body.username || ""
            );

        const password =
            String(
                req.body.password || ""
            );


        const correctUsername =
            process.env.ADMIN_USERNAME;

        const correctPassword =
            process.env.ADMIN_PASSWORD;


        if (
            !correctUsername ||
            !correctPassword
        ) {

            return res.status(500).json({
                error:
                    "Admin credentials are not configured on the server."
            });

        }


        if (
            username !== correctUsername ||
            password !== correctPassword
        ) {

            return res.status(401).json({
                error:
                    "Wrong admin username or password."
            });

        }


        const token =
            createToken();


        adminSessions.add(
            token
        );


        res.json({
            token
        });

    }
);


/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
    "/api/admin/logout",
    requireAdmin,
    (req, res) => {

        const token =
            req.headers.authorization
                .substring(7);

        adminSessions.delete(
            token
        );

        res.json({
            success: true
        });

    }
);


/* =========================================================
   ADMIN DASHBOARD
========================================================= */

app.get(
    "/api/admin/dashboard",
    requireAdmin,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    "SELECT COUNT(*) FROM users"
                );


            res.json({

                price,

                onlinePlayers:
                    onlineSockets.size,

                accounts:
                    Number(
                        result.rows[0].count
                    ),

                database:
                    true

            });

        } catch (error) {

            console.error(
                "ADMIN DASHBOARD ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Database error."
            });

        }

    }
);


/* =========================================================
   ADMIN LEADERBOARD
========================================================= */

app.get(
    "/api/admin/leaderboard",
    requireAdmin,
    async (req, res) => {

        try {

            res.json(
                await getLeaderboard()
            );

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Database error."
            });

        }

    }
);


/* =========================================================
   ADMIN SET PRICE
========================================================= */

app.post(
    "/api/admin/price",
    requireAdmin,
    (req, res) => {

        const newPrice =
            Number(
                req.body.price
            );


        if (
            !Number.isFinite(
                newPrice
            ) ||
            newPrice <= 0
        ) {

            return res.status(400).json({
                error:
                    "Invalid price."
            });

        }


        price =
            newPrice;


        broadcast({

            type:
                "market",

            price

        });


        broadcast({

            type:
                "event",

            message:
                "👑 Admin changed BANANA price to $" +
                price.toFixed(8)

        });


        res.json({

            success:
                true,

            price

        });

    }
);


/* =========================================================
   ADMIN MARKET EVENT
========================================================= */

app.post(
    "/api/admin/event",
    requireAdmin,
    (req, res) => {

        const event =
            req.body.event;


        if (
            event !== "pump" &&
            event !== "crash"
        ) {

            return res.status(400).json({
                error:
                    "Invalid market event."
            });

        }


        if (event === "pump") {

            price *= 1.25;

        }


        if (event === "crash") {

            price *= 0.75;

        }


        price =
            Math.max(
                price,
                0.00000001
            );


        const message =
            event === "pump"

            ? "📈 BANANA MARKET PUMP! +25%"

            : "📉 BANANA MARKET CRASH! -25%";


        broadcast({

            type:
                "market",

            price

        });


        broadcast({

            type:
                "event",

            message

        });


        res.json({

            success:
                true,

            price

        });

    }
);


/* =========================================================
   ADMIN NEWS
========================================================= */

app.post(
    "/api/admin/news",
    requireAdmin,
    (req, res) => {

        const message =
            String(
                req.body.message || ""
            ).trim();


        if (!message) {

            return res.status(400).json({
                error:
                    "News message is empty."
            });

        }


        if (message.length > 500) {

            return res.status(400).json({
                error:
                    "News message is too long."
            });

        }


        broadcast({

            type:
                "event",

            message:
                "📰 " + message

        });


        res.json({
            success: true
        });

    }
);


/* =========================================================
   ADMIN PLAYER MODIFICATION
========================================================= */

app.post(
    "/api/admin/player",
    requireAdmin,
    async (req, res) => {

        try {

            const username =
                String(
                    req.body.username || ""
                );

            const type =
                req.body.type;

            const action =
                req.body.action;

            const amount =
                Number(
                    req.body.amount
                );


            if (
                !username ||
                !Number.isFinite(amount) ||
                amount <= 0
            ) {

                return res.status(400).json({
                    error:
                        "Invalid player modification."
                });

            }


            if (
                type !== "cash" &&
                type !== "banana"
            ) {

                return res.status(400).json({
                    error:
                        "Invalid modification type."
                });

            }


            if (
                action !== "add" &&
                action !== "remove"
            ) {

                return res.status(400).json({
                    error:
                        "Invalid modification action."
                });

            }


            const user =
                await getUserByUsername(
                    username
                );


            if (!user) {

                return res.status(404).json({
                    error:
                        "Player not found."
                });

            }


            if (type === "cash") {

                if (
                    action === "add"
                ) {

                    user.cash +=
                        amount;

                } else {

                    user.cash =
                        Math.max(
                            0,
                            user.cash -
                            amount
                        );

                }

            }


            if (type === "banana") {

                if (
                    action === "add"
                ) {

                    user.bananas +=
                        amount;

                } else {

                    user.bananas =
                        Math.max(
                            0,
                            user.bananas -
                            amount
                        );

                }

            }


            await saveUser(
                user
            );


            await checkAchievements(
                user
            );


            broadcast({

                type:
                    "event",

                message:
                    "👑 Admin modified " +
                    user.username +
                    "'s portfolio."

            });


            await broadcastLeaderboard();


            res.json({

                success:
                    true,

                username:
                    user.username,

                cash:
                    user.cash,

                bananas:
                    user.bananas

            });

        } catch (error) {

            console.error(
                "ADMIN PLAYER ERROR:",
                error
            );

            res.status(500).json({
                error:
                    "Database error."
            });

        }

    }
);


/* =========================================================
   WEBSOCKET
========================================================= */

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

                try {

                    const data =
                        JSON.parse(
                            raw.toString()
                        );


                    /* =========================
                       AUTHENTICATE
                    ========================= */

                    if (
                        data.type ===
                        "authenticate"
                    ) {

                        const userId =
                            userSessions.get(
                                data.token
                            );


                        if (!userId) {

                            socket.send(
                                JSON.stringify({

                                    type:
                                        "error",

                                    message:
                                        "Invalid login session."

                                })
                            );

                            return;

                        }


                        socket.userToken =
                            data.token;


                        const user =
                            await getUserById(
                                userId
                            );


                        if (!user)
                            return;


                        socket.send(
                            JSON.stringify({

                                type:
                                    "welcome",

                                price,

                                cash:
                                    user.cash,

                                bananas:
                                    user.bananas,

                                username:
                                    user.username

                            })
                        );


                        await sendPortfolio(
                            socket,
                            user
                        );

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


                        if (!user) {

                            socket.send(
                                JSON.stringify({

                                    type:
                                        "error",

                                    message:
                                        "Please log in first."

                                })
                            );

                            return;

                        }


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


                        if (!user) {

                            socket.send(
                                JSON.stringify({

                                    type:
                                        "error",

                                    message:
                                        "Please log in first."

                                })
                            );

                            return;

                        }


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

                } catch (error) {

                    console.error(
                        "WEBSOCKET ERROR:",
                        error
                    );

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


/* =========================================================
   MARKET TICK
========================================================= */

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

    },
    900
);


/* =========================================================
   START SERVER
========================================================= */

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
            "❌ Failed to start server:",
            error
        );

        process.exit(1);

    }

}


start();
