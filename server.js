const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;


/* ==========================================
   WEBSITE
========================================== */

const publicFolder = path.join(__dirname, "public");

app.use(express.static(publicFolder));

app.get("/", (req, res) => {
    res.sendFile(path.join(publicFolder, "index.html"));
});


/* ==========================================
   BANANA COIN MARKET
========================================== */

let price = 0.00004269;

const STARTING_CASH = 10000;

const players = new Map();


/* ==========================================
   BROADCAST
========================================== */

function broadcast(data) {

    const message = JSON.stringify(data);

    wss.clients.forEach(client => {

        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }

    });

}


/* ==========================================
   MARKET MOVEMENT
========================================== */

function moveMarket() {

    let movement =
        (Math.random() - 0.48) * 0.045;

    /*
       Occasional memecoin chaos
    */

    if (Math.random() < 0.035) {

        movement +=
            (Math.random() - 0.5) * 0.30;

    }

    price *= 1 + movement;

    price = Math.max(
        price,
        0.00000001
    );

}


/* ==========================================
   SEND MARKET
========================================== */

function sendMarket() {

    broadcast({

        type: "market",

        price: price

    });

}


/* ==========================================
   SEND PORTFOLIO
========================================== */

function sendPortfolio(socket, player) {

    if (
        socket.readyState !==
        WebSocket.OPEN
    ) {
        return;
    }

    socket.send(
        JSON.stringify({

            type: "portfolio",

            cash: player.cash,

            bananas: player.bananas

        })
    );

}


/* ==========================================
   PLAYER CONNECTION
========================================== */

wss.on("connection", socket => {

    /*
       Every new player starts with
       $10,000 fake money.
    */

    const player = {

        cash: STARTING_CASH,

        bananas: 0

    };

    players.set(
        socket,
        player
    );


    /*
       Tell the new player about
       the current market.
    */

    socket.send(
        JSON.stringify({

            type: "welcome",

            price: price,

            cash: player.cash,

            bananas: player.bananas

        })
    );


    /*
       Update player counter.
    */

    broadcast({

        type: "players",

        count: players.size

    });


    /* ======================================
       PLAYER MESSAGES
    ====================================== */

    socket.on("message", rawMessage => {

        let data;

        try {

            data =
                JSON.parse(
                    rawMessage.toString()
                );

        } catch {

            return;

        }


        /* ==================================
           BUY
        ================================== */

        if (data.type === "buy") {

            const amount =
                Number(data.amount);


            if (
                !Number.isFinite(amount) ||
                amount <= 0
            ) {
                return;
            }


            const cost =
                amount * price;


            if (cost > player.cash) {

                socket.send(
                    JSON.stringify({

                        type: "error",

                        message:
                            "Not enough fake money! 🍌"

                    })
                );

                return;

            }


            player.cash -= cost;

            player.bananas += amount;


            broadcast({

                type: "trade",

                message:
                    "🟢 Someone bought " +
                    Math.floor(amount)
                        .toLocaleString() +
                    " BANANA"

            });


            sendPortfolio(
                socket,
                player
            );

        }


        /* ==================================
           SELL
        ================================== */

        if (data.type === "sell") {

            const amount =
                Number(data.amount);


            if (
                !Number.isFinite(amount) ||
                amount <= 0
            ) {
                return;
            }


            if (
                amount >
                player.bananas
            ) {

                socket.send(
                    JSON.stringify({

                        type: "error",

                        message:
                            "You don't own that much BANANA! 🍌"

                    })
                );

                return;

            }


            player.bananas -= amount;

            player.cash +=
                amount * price;


            broadcast({

                type: "trade",

                message:
                    "🔴 Someone sold " +
                    Math.floor(amount)
                        .toLocaleString() +
                    " BANANA"

            });


            sendPortfolio(
                socket,
                player
            );

        }

    });


    /* ======================================
       PLAYER DISCONNECT
    ====================================== */

    socket.on("close", () => {

        players.delete(socket);

        broadcast({

            type: "players",

            count: players.size

        });

    });

});


/* ==========================================
   MARKET CLOCK
========================================== */

setInterval(() => {

    moveMarket();

    sendMarket();

}, 900);


/* ==========================================
   START SERVER
========================================== */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `🍌 Banana Coin server running on port ${PORT}`
        );

        console.log(
            `📁 Serving website from: ${publicFolder}`
        );

    }
);
