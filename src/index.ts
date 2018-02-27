import express = require("express");
import request = require("request");
import bodyParser = require("body-parser");
import { format } from "util";

const MAX_QUEUE_SIZE = process.env.MAX_QUEUE_SIZE || 100;

const WEBHOOK_TEMPLATE = "https://discordapp.com/api/webhooks/%s/%s";
const DISCORD_PREFIX = "x-ratelimit-";
const DISCORD_LIMIT = DISCORD_PREFIX + "limit";
const DISCORD_REMAINING = DISCORD_PREFIX + "remaining";
const DISCORD_RESET = DISCORD_PREFIX + "reset";

let rates: {
	[index: string]: {
		limit: number;
		remaining: number;
		reset: number;
		errors: number;
		queue: {
			payload: string;
			hookId: string;
			hookToken: string;
		}[];
	}
} = {};

function getRateData(hookId: string) {
	let rateData = rates[hookId];
	if (!rateData) {
		rateData = {
			limit: 0,
			remaining: 1,
			reset: -1,
			errors: 0,
			queue: []
		};
		rates[hookId] = rateData;
	}
	return rateData;
}

function sendRequest(hookId: string, hookToken: string, payload: string) {
	let rateData = getRateData(hookId);
	if (rateData.remaining > 0) {
		rateData.remaining--;
		request(format(WEBHOOK_TEMPLATE, hookId, hookToken), {
			method: "post",
			headers: {
				["user-agent"]: "",
				["content-type"]: "application/json"
			},
			body: payload,
		})
			.on("response", res => {
				let reset = Number(res.headers[DISCORD_RESET]);
				let limit = Number(res.headers[DISCORD_LIMIT]);
				let remaining = Number(res.headers[DISCORD_REMAINING]);
				if (!isNaN(reset)) { rateData.reset = reset; }
				if (!isNaN(limit)) { rateData.limit = limit; }
				if (!isNaN(remaining)) { rateData.remaining = remaining; }
				if (res.statusCode == 429) {
					rateData.queue.push({
						payload: payload,
						hookId: hookId,
						hookToken: hookToken,
					});
				}
			});
	} else {
		rateData.queue.push({
			payload: payload,
			hookId: hookId,
			hookToken: hookToken,
		});
	}
}

setInterval(() => {
	let time = Math.floor(Date.now()/1000);
	Object.keys(rates).forEach(key => {
		let rateData = rates[key];
		if (rateData.reset !== -1 && time >= rateData.reset) {
			rateData.remaining = rateData.limit;
			rateData.reset = -1;
			for (let i = rateData.queue.length - 1; i >= 0; i--) {
				if (rateData.remaining > 0) {
					let hookRequest = rateData.queue.splice(i, 1)[0];
					sendRequest(hookRequest.hookId, hookRequest.hookToken, hookRequest.payload);
				}
			}
		}
	});
}, 1000);

const app = express();

app.use(bodyParser.text({ type: "*/*" }));

app.post("/api/webhooks/:hookId/:hookToken", (req, res) => {
	let hookId = req.params.hookId;
	let rateData = getRateData(hookId);
	if (rateData.queue.length > MAX_QUEUE_SIZE) {
		res
			.status(400)
			.end("Error: Too many requests!");
		rateData.errors++;
	} else {
		res
			.status(200)
			.end();
		sendRequest(hookId, req.params.hookToken, req.body);
	}
});

app.get("/", (req, res) => {
	let counts: { [index: string]: number } = {};
	let errors: { [index: string]: number } = {};
	Object.keys(rates).forEach(key => {
		counts[key] = rates[key].queue.length;
		errors[key] = rates[key].errors;
	});
	res.json({
		counts: counts,
		errors: errors,
	});
	res.end();
});

app.listen(80);