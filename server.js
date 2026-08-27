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

    if (Math.random() < 0.
