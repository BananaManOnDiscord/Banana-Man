const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

let price = 0.00004269;

const STARTING_CASH = 10000;

const players = new Map();

function randomMovement() {
    let move = (Math.random() - 0.48) * 0.045;

    if (Math.random() < 0.035) {
        move += (Math.random() - 0.5) * 0.30;
    }

    price *= 1 + move;

    price = Math.max(price, 0.00000001);
}

function broadcast(data) {

    const message = JSON.stringify(data);

    wss.clients.forEach(client => {

        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }

    });
}

function sendMarket() {

    broadcast({
        type: "market",
        price: price
    });

}

wss.on("connection", socket => {

    let player = {
        cash: STARTING_CASH,
        bananas: 0
    };

    players.set(socket, player);

    socket.send(JSON.stringify({
        type: "welcome",
        price: price,
        cash: player.cash,
        bananas: player.bananas
    }));

    broadcast({
        type: "players",
        count: players.size
    });


    socket.on("message", message => {

        let data;

        try {
            data = JSON.parse(message);
        } catch {
            return;
        }


        /* ---------------- BUY ---------------- */

        if (data.type === "buy") {

            const amount = Number(data.amount);

            if (!Number.isFinite(amount) || amount <= 0) {
                return;
            }

            const cost = amount * price;

            if (cost > player.cash) {
                socket.send(JSON.stringify({
                    type: "error",
                    message: "Not enough fake money!"
                }));

                return;
            }

            player.cash -= cost;
            player.bananas += amount;


            broadcast({
                type: "trade",
                message:
                    "🟢 Someone bought " +
                    Math.floor(amount).toLocaleString() +
                    " BANANA"
            });

            sendPortfolio(socket, player);
        }


        /* ---------------- SELL ---------------- */

        if (data.type === "sell") {

            const amount = Number(data.amount);

            if (!Number.isFinite(amount) || amount <= 0) {
                return;
            }

            if (amount > player.bananas) {

                socket.send(JSON.stringify({
                    type: "error",
                    message: "You don't own that much BANANA!"
                }));

                return;
            }

            player.bananas -= amount;
            player.cash += amount * price;


            broadcast({
                type: "trade",
                message:
                    "🔴 Someone sold " +
                    Math.floor(amount).toLocaleString() +
                    " BANANA"
            });

            sendPortfolio(socket, player);
        }


        /* ---------------- PUMP ---------------- */

        if (data.type === "pump") {

            price *= 1.25;

            broadcast({
                type: "event",
                message: "🚀 BANANA COIN JUST PUMPED!"
            });

            sendMarket();
        }


        /* ---------------- CRASH ---------------- */

        if (data.type === "crash") {

            price *= 0.55;

            price = Math.max(
                price,
                0.00000001
            );

            broadcast({
                type: "event",
                message: "💥 BANANA COIN JUST CRASHED!"
            });

            sendMarket();
        }

    });


    socket.on("close", () => {

        players.delete(socket);

        broadcast({
            type: "players",
            count: players.size
        });

    });

});


function sendPortfolio(socket, player) {

    if (socket.readyState !== WebSocket.OPEN)
        return;

    socket.send(JSON.stringify({

        type: "portfolio",

        cash: player.cash,

        bananas: player.bananas

    }));

}


/* ---------------- MARKET LOOP ---------------- */

setInterval(() => {

    randomMovement();

    sendMarket();

}, 900);


/* ---------------- SERVER ---------------- */

server.listen(PORT, () => {

    console.log(
        `🍌 Banana Coin server running on port ${PORT}`
    );

});