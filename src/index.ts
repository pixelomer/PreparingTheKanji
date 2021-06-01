import express, { RequestHandler } from "express";
import fetch from "node-fetch";
import fs from "fs";

interface Stories {
	heisig?: string;
	koohii: Array< { author: string, score: number, story: string } >;
	comment?: string;
	primitive?: string;
};

interface CardInfo {
	fields: { [field: string]: { value: string, order: number } };
	note: number;
}

async function performAction(action: string, data?): Promise<any> {
	const body: { action: string, version: number, params? } = {
		action: action,
		version: 6
	};
	if (data != null) {
		body.params = data;
	}
	const response = await fetch("http://localhost:8765", {
		method: "POST",
		body: JSON.stringify(body)
	});
	const json = await response.json();
	if (data["error"] != null) {
		throw new Error(data["error"]);
	}
	return json["result"];
}

async function getCardInfo(cardID: number): Promise<CardInfo> {
	const [cardInfo] = await performAction("cardsInfo", {
		cards: [cardID]
	});
	return cardInfo;
}

async function fetchStories(kanji: string): Promise<Stories> {
	if (!fs.existsSync("cache")) {
		fs.mkdirSync("cache");
	}
	const cacheFile = `cache/${kanji}.json`;
	if (fs.existsSync(cacheFile)) {
		try {
			const json = JSON.parse(fs.readFileSync(`cache/${kanji}.json`, { encoding: 'utf-8' }));
			if (json != null) {
				return json;
			}
		} catch {}
	}
	kanji = encodeURIComponent(kanji);
	const URL = "http://hochanh.github.io/rtk/" + kanji + "/index.html";
	const response = await fetch(URL);
	const text = (await response.text());
	const koohiiStories = text
		.match(/<h2>Koohii stories:<\/h2>([\s\S]*?)<hr>/)[1]
		.match(/<p>[\s\S]*?<\/p>/g)
		.map((story) => {
			const match = story.match(/<p>[0-9]+\) \[<a.*?>([^<]*?)<\/a>\] .*?\(([0-9]+)\): ([\s\S]*?)<\/p>/);
			return {
				author: match[1],
				score: parseInt(match[2]),
				story: match[3]
			};
		});
	function tryMatch(header) {
		const regex = new RegExp(`<h2>${header}:<\\/h2>[^<]*?<p>([\\s\\S]*?)<\\/p>`);
		return (text.match(regex) ?? {})[1] ?? null;
	}
	const heisigStory = tryMatch("Heisig story");
	const heisigComment = tryMatch("Heisig comment");
	const primitive = tryMatch("Primitive");
	const result = {
		koohii: koohiiStories,
		heisig: heisigStory,
		comment: heisigComment,
		primitive: primitive
	};
	fs.writeFileSync(cacheFile, JSON.stringify(result), { encoding: 'utf-8' });
	return result;
}

async function main() {
	if (process.argv.length < 3) {
		console.error(`Usage: ${process.argv[1]} <deck>`);
		process.exit(1);
	}

	const deckName = process.argv[2];
	let allCards: Array<number> = null;

	const app = express();
	app.use(express.urlencoded({ extended: false }));
	app.use(express.static('static'));

	app.use(async(request, response, next) => {
		try {
			allCards = await performAction("findCards", {
				query: `"deck:${deckName}"`
			});
			next();
		}
		catch (error) {
			response.status(500).type('text/plain').send(`Failed to communicate with AnkiConnect.\n\n${error}`);
		}
	});

	app.get('/', async(request, response) => {
		const newEmptyCards = await performAction("findCards", {
			query: `"deck:${deckName}" AND "story:" AND "is:new"`
		});
		let index = Math.max(1, allCards.indexOf(newEmptyCards[0]) + 1);
		response.redirect(`/card/${index}`)
	});

	app.get(/\/v4\/([0-9]+)\.html/, async(request, response) => {
		const URL = `http://hochanh.github.io/rtk/v4/${request.params[0]}.html`;
		const githubResponse = await fetch(URL);
		const data = await githubResponse.text();
		const match = data.match(/href="\.\.\/([^/]+)\/index.html"/);
		if (match == null) {
			response.status(404).send("RTKv6 Card Not Found");
			return;
		}
		const kanji = match[1];
		const [cardID] = await performAction("findCards", {
			query: `"deck:${deckName}" "Kanji:${kanji}"`
		});
		response.redirect(`/card/${allCards.indexOf(cardID) + 1}`);
	});

	const cardHandler: RequestHandler = async(request, response) => {
		const index = parseInt(request.params.card) - 1;
		if (isNaN(index)) {
			response.redirect("/");
			return;
		}
		if (allCards[index] == null) {
			response.status(404).send("Card not found");
			return;
		}

		let cardInfo = await getCardInfo(allCards[index]);

		if (request.method === "POST") {
			if (cardInfo.fields.Kanji.value !== request.body["kanji"]) {
				response.status(400).type('text/plain').send("Kanji mismatch. Go back, refresh and try again.");
				return;
			}
		}
		
		let prevCard: CardInfo = null;
		let prevLink = `<span id="prev" class="disabled">&lt;</span>`;
		if (index !== 0) {
			prevCard = await getCardInfo(allCards[index-1]);
			prevLink = `<a id="prev" href="/card/${index}">&lt;${prevCard.fields.Kanji.value}</a>`;
		}

		let nextCard: CardInfo = null;
		let nextLink = `<span id="next" class="disabled">&gt;</span>`;
		if (index !== allCards.length - 1) {
			nextCard = await getCardInfo(allCards[index+1]);
			nextLink = `<a id="next" href="/card/${index+2}">${nextCard.fields.Kanji.value}&gt;</a>`;
		}

		const stories = await fetchStories(cardInfo.fields.Kanji.value);

		if (request.method === "POST") {
			const story = request.body["story"];
			const content = request.body["content"];
			let newNote;
			switch (story) {
				case "heisig":
					newNote = stories.heisig;
					break;
				case "custom":
					newNote = content;
					break;
				default:
					newNote = (stories.koohii[parseInt(story)] ?? { story: "" }).story;
					break;
			}
			await performAction("updateNoteFields", {
				"note": {
					"id": cardInfo.note,
					"fields": {
						"Story": newNote
					}
				}
			});
			cardInfo = await getCardInfo(allCards[index]);
		}

		const koohiiHTML = stories.koohii.map((story, index) => {
			return `<p><label><input type="radio" name="story" value="${index}"/><u><b>${story.author} (${story.score}):</b></u> ${story.story}</label></p>`;
		}).join('');
		let heisigHTML = stories.heisig ?
`<h2>Heisig Story</h2>
<p>
  <label><input type="radio" name="story" value="heisig"/>${stories.heisig}</label>
</p>` : "";
		heisigHTML += (stories.primitive || stories.comment) ? "<h2>Heisig Notes</h2>" : "";
		heisigHTML += stories.primitive ? `<p>${stories.primitive}</p>` : "";
		heisigHTML += stories.comment ? `<p>${stories.comment}</p>` : "";
		let alternativeKanji = "";
		if (cardInfo.fields["Alternative Kanji"].value) {
			alternativeKanji = `<span class="alternative kanji">${cardInfo.fields["Alternative Kanji"].value}</span><br/>`;
		}
		const HTML =
`<!DOCTYPE html>
<html>
<head>
  <title>${cardInfo.fields.Kanji.value} - ${cardInfo.fields.Keyword.value}</title>
	<link rel="stylesheet" href="/style.css">
</head>
<body>
	<main>
	  <div id="info">
			<span id="keyword">
			  <a target="_blank" href="http://hochanh.github.io/rtk/${cardInfo.fields.Kanji.value}/">${cardInfo.fields.Keyword.value}</a>
			</span><br/>
			<span class="kanji">${cardInfo.fields.Kanji.value}</span><br/>
			${alternativeKanji}
			${prevLink}
			${nextLink}
		</div>
		<div id="stories">
			<form method="post">
				<input type="hidden" id="verify" name="kanji" value="${cardInfo.fields.Kanji.value}" />
				${heisigHTML}
				<h2>Koohii Stories</h2>
				${koohiiHTML}
				<h2>Your Story</h2>
				<label><input type="radio" name="story" value="custom" checked />Use custom story</label><br/>
				<textarea rows=5 name="content">${cardInfo.fields.Story.value}</textarea>
				<br/><br/>
				<input id="save" type="submit" value="Save Selected Story"/>
				<br/><br/><br/>
			</form>
		</div>
	</main>
</body>
</html>
`;
		response.send(HTML);
	};

	const cardPath = "/card/:card([0-9]+)"
	app.get(cardPath, cardHandler);
	app.post(cardPath, cardHandler);

	app.listen(3000, "127.0.0.1", () => {
		console.log("Listening on http://127.0.0.1:3000")
	});
}

main();