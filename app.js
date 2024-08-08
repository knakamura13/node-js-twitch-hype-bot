/**
 * Twitch Hype Bot
 *
 * This script implements a Twitch chatbot that connects to specified Twitch channels,
 * monitors chat messages, and performs the following functionalities:
 *
 * - Tracks +2 and -2 messages in chat to gauge positive and negative hype.
 * - Maintains daily counters for +2 and -2 messages and stores them in MongoDB.
 * - Implements a sliding window to calculate and record the moving average of +2 and -2 messages every 60 seconds.
 * - Records the moving average in MongoDB with a simplified timestamp (year, month, day, hour, minute).
 * - Resets daily hype message counters at 8am PST every weekday using a cron job.
 * - Connects to MongoDB and ensures the necessary collections ('chat_user_stats' and 'hype_stats') are indexed.
 * - Handles chat messages to count and queue messages, detect hype, and record user chat stats.
 * - Uses a limiter function to manage the rate of message sending to the chat.
 * - Filters out messages from bots, moderators, commands, and messages containing URLs.
 *
 * Global Properties:
 * - DRY_RUN: Toggle to enable/disable real message sending to Twitch channels.
 * - HYPE_MIN_MSG_LEN: Minimum length for a message to be considered for hype tracking.
 * - HYPE_MAX_MSG_LEN: Maximum length for a message to be considered for hype tracking.
 * - HYPE_MAX_QUEUE_LEN: Maximum number of messages to queue per channel for hype detection.
 * - HYPE_THRESHOLD: Number of duplicate messages required to detect hype.
 * - HYPE_THROTTLE: Throttle duration (in milliseconds) for sending hype messages.
 * - HYPE_DEQUEUE_TIMER: Timer interval (in milliseconds) to reset message queues.
 * - MSG_SEND_DELAY: Delay (in milliseconds) before sending a queued message.
 * - HYPE_USER_IGNORE_LIST: List of users whose messages are ignored for hype tracking (e.g., bots).
 * - TWITCH_PREFERENCES: Contains channel names and credentials for connecting to Twitch.
 * - REGEX_CONTAINS_URI: Regular expression to detect URLs in messages.
 * - WINDOW_SIZE_MS: Sliding window size (in milliseconds) for moving average calculation.
 *
 * Libraries Used:
 * - lodash: Utility library for JavaScript.
 * - chalk: Terminal string styling library.
 * - dotenv: Environment variable management library.
 * - twitch-js: Library for interacting with Twitch chat.
 * - mongodb: MongoDB driver for Node.js.
 * - cron: Library for scheduling tasks.
 */

/*******************
 * Library Imports *
 *******************/

import _ from 'lodash';
import colors from 'chalk';
import dotenv from 'dotenv';
import TwitchJs from 'twitch-js';
import { MongoClient } from 'mongodb';
import { CronJob } from 'cron';

// Dotenv initialization
dotenv.config();

// MongoDB initialization
connectToMongo().catch(console.error);

/*********************
 * Global Properties *
 *********************/

// Toggle ability to send real messages to Twitch channels
const DRY_RUN = false;

// Configure hype parameters
const HYPE_MIN_MSG_LEN = 1,
    HYPE_MAX_MSG_LEN = 256,
    HYPE_MAX_QUEUE_LEN = 10,
    HYPE_THRESHOLD = 5,
    HYPE_THROTTLE = 30000,
    HYPE_DEQUEUE_TIMER = HYPE_THROTTLE * 2,
    MSG_SEND_DELAY = 150,
    HYPE_USER_IGNORE_LIST = ['nightbot'];

const TWITCH_PREFERENCES = {
    channels: [
        'squishy_life',
        'northernlion'
    ],
    credentials: {
        username: process.env.TWITCH_USERNAME.toLowerCase(),
        token: process.env.TWITCH_PASSWORD
    }
};

// Regex for detecting a URI
const REGEX_CONTAINS_URI = new RegExp('(http|ftp|https):\\/\\/([\\w_-]+(?:\\.[\\w_-]+)+)([\\w.,@?^=%&:/~+#-]*[\\w@?^=%&/~+#-])');

let messageQueues = {};
let db;

// Initialize counters for +2 and -2 messages and the sliding window
let dailyPositiveCount = 0;
let dailyNegativeCount = 0;
let messageWindow = [];
const WINDOW_SIZE_MS = 60000; // 60 seconds

/******************
 * TwitchJS Setup *
 ******************/

// Create an instance of TwitchJS.
const chat = new TwitchJs.Chat({
    username: TWITCH_PREFERENCES.credentials.username,
    token: TWITCH_PREFERENCES.credentials.token,
    log: { level: 'error' }
});

// Extends TwitchJS functionality with addition of a limiter to queue message sending processes
chat.say = limiter((msg, channel) => {
    if (DRY_RUN) {
        console.log(`${colors.gray(getFormattedTime())} ${msg} -- (DRY RUN ENABLED)`);
        return;
    }

    setTimeout(() => {
        chat.send(`PRIVMSG #${channel} :${msg}`);
    }, MSG_SEND_DELAY);
}, 1500);

/********************
 * Helper Functions *
 ********************/

/**
 * Connects to the Mongo DB.
 *
 * @returns {Promise<void>}
 */
async function connectToMongo() {
    try {
        const mongoClient = new MongoClient(process.env.MONGO_URL);
        await mongoClient.connect();
        db = mongoClient.db('twitch_hype_bot');

        // Ensure chat_user_stats collection is indexed
        await db.collection('chat_user_stats').createIndex({ UserName: 1 }, { unique: true });

        // Ensure hype_stats collection is indexed
        await db.collection('hype_stats').createIndex({ timestamp: 1 });

        console.log('Connected to MongoDB and indexes created.');
    } catch (err) {
        console.error('Failed to connect to MongoDB:', err);
        throw err;
    }
}

/**
 * Returns the current time as a string, formatted with hours, minutes, seconds, and period.
 *
 * @example "[2:47:10 AM]"
 * @returns {string}
 */
const getFormattedTime = () =>
    `[${new Date().toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true })}]`;

/**
 * Create a queue of `fn` calls and execute them in order after `wait` milliseconds.
 *
 * @param fn {function}
 * @param wait {int}
 * @returns {function(): void}
 */
function limiter(fn, wait) {
    let isCalled = false,
        calls = [];

    const caller = function () {
        if (calls.length && !isCalled) {
            isCalled = true;
            calls.shift().call();
            setTimeout(function () {
                isCalled = false;
                caller();
            }, wait);
        }
    };

    return function () {
        calls.push(fn.bind(this, ...arguments));
        caller();
    };
}

/******************************
 * Message Handling Functions *
 ******************************/

/**
 * Send a message to participate in the hype.
 *
 * @param channel
 * @param message
 */
async function sendHypeMessage(channel, message) {
    await recordUserChatStats(channel, TWITCH_PREFERENCES.credentials.username);

    console.log(`${colors.gray(getFormattedTime())} '${channel}': "${message}".`);
    chat.say(message, channel);
}

const sendHypeMessageThrottled = _.throttle(sendHypeMessage, HYPE_THROTTLE, { 'trailing': false });

/**
 * Detect hype on a given channel, then participate in hype using sendHypeMessage().
 *
 * Uses a channel name as input to load a channel's message queue.
 * If the queue contains enough duplicate messages, we consider that hype.
 *
 * @param channel
 */
function detectHype(channel) {
    let messageCounts = {};

    // Count the occurrences of each unique message in the queue
    for (let message of messageQueues[channel]) {
        if (!Number.isInteger(messageCounts[message])) {
            messageCounts[message] = 0;
        }

        messageCounts[message] += 1;

        // If number of occurrences of a message exceeds HYPE_THRESHOLD, then the hype is real
        if (messageCounts[message] >= HYPE_THRESHOLD) {
            messageQueues[channel] = [];
            sendHypeMessageThrottled(channel, message);
            return;
        }
    }
}

/**
 * Occasionally reset all message queues to account for slow chats.
 */
function startDequeueDisposalProcess() {
    setInterval(() => {
        messageQueues = {};
    }, HYPE_DEQUEUE_TIMER);
}

/**
 * Queue all incoming messages per channel with max queue size to be determined.
 *
 * Ignores bot (moderator) messages.
 *
 * @param channel
 * @param username
 * @param message
 * @param isModerator
 * @param emote
 */
function enqueueChatMessage(channel, username, message, isModerator, emote = null) {
    message = emote ? emote : message;

    // Filter/skip messages that needn't contribute to hype
    if (filterEnqueueMessage(channel, username, message, isModerator)) {
        return;
    }

    // Record stats about the current user
    recordUserChatStats(channel, username);

    // Ensure the channel queue exists
    if (!Array.isArray(messageQueues[channel])) {
        messageQueues[channel] = [];
    }

    // Dequeue the oldest message
    if (messageQueues[channel].length >= HYPE_MAX_QUEUE_LEN) {
        messageQueues[channel].shift();
    }

    // Enqueue the new message
    if (message.length >= HYPE_MIN_MSG_LEN && message.length <= HYPE_MAX_MSG_LEN) {
        messageQueues[channel].push(message);
        detectHype(channel);
    }

    // Update counters and sliding window for +2 and -2 messages
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('+2')) {
        dailyPositiveCount++;
        updateMessageWindow('+2');
    } else if (lowerMessage.includes('-2')) {
        dailyNegativeCount++;
        updateMessageWindow('-2');
    }
}

/**
 * Filter a message before enqueue, returning True if message should be filtered out of the queue.
 *
 * @param channel
 * @param username
 * @param message
 * @param isModerator
 * @returns {boolean}
 */
function filterEnqueueMessage(channel, username, message, isModerator) {
    // Moderator or bot sent the message
    if (isModerator || HYPE_USER_IGNORE_LIST.includes(username.toLowerCase())) {
        return true;
    }

    // Message is a command
    if (message.charAt(0) === '!') {
        return true;
    }

    // Message contains a URL
    if (REGEX_CONTAINS_URI.test(message)) {
        return true;
    }

    // Message is okay
    return false;
}

/**
 * Record message count stats for current user with MongoDB.
 *
 * @param channel
 * @param username
 */
async function recordUserChatStats(channel, username) {
    try {
        const filter = { Channel: channel, UserName: username };
        const update = {
            $inc: { MessageCount: 1 },
            $setOnInsert: { Channel: channel, UserName: username }
        };
        const options = { upsert: true };

        await db.collection('chat_user_stats').updateOne(filter, update, options);
    } catch (err) {
        console.error('Error updating chat user stats:', err);
    }
}

/**
 * Record the moving average in MongoDB.
 *
 * @param movingAverage
 */
async function recordMovingAverage(movingAverage) {
    try {
        const now = new Date();
        const timestamp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());

        await db.collection('hype_stats').insertOne({ timestamp, movingAverage });
    } catch (err) {
        console.error('Error recording moving average:', err);
    }
}

/**
 * Update the message window and calculate the moving average.
 *
 * @param type
 */
function updateMessageWindow(type) {
    const now = Date.now();
    messageWindow.push({ time: now, type });

    // Remove messages outside the window
    messageWindow = messageWindow.filter(msg => now - msg.time <= WINDOW_SIZE_MS);

    // Calculate the moving average
    let positiveCount = 0;
    let negativeCount = 0;
    for (const msg of messageWindow) {
        if (msg.type === '+2') positiveCount++;
        else if (msg.type === '-2') negativeCount++;
    }

    const movingAverage = (positiveCount * 2) - (negativeCount * 2);
    const positiveNegativeSymbol = movingAverage >= 0 ? '+' : '-';
    console.log(`${getFormattedTime()} Moving Average: ${positiveNegativeSymbol}${movingAverage}`);

    // Store the moving average in MongoDB
    recordMovingAverage(movingAverage);
}

/**
 * Handle any message sent by myself.
 *
 * @param channel
 * @param username
 * @param message
 */
function handleMyMessage(channel, username, message) {
    console.log(`${getFormattedTime()} <${colors.cyanBright(username)}> ${message}`);
}

/**
 * Handle any message sent from any other user.
 *
 * @param channel
 * @param username
 * @param message
 */
function handleOtherMessage(channel, username, message) {
    // Message includes an @ mention
    if (message.toLowerCase().includes('@' + TWITCH_PREFERENCES.credentials.username)) {
        const iterableMessage = message.split(' ').entries();

        let _message = '';

        // Reconstruct the original message with the emboldened username
        for (let [index, word] of iterableMessage) {
            if (word.toLowerCase().includes('@' + TWITCH_PREFERENCES.credentials.username)) {
                word = colors.whiteBright.bold(word);
            }

            if (index > 0) {
                _message += ' ';
            }

            _message += word;
        }

        console.log(colors.bgRed(`${getFormattedTime()} <${username}> ${_message}`));
    }
}

/**
 * Reset the daily tallies and store them in MongoDB.
 */
async function resetDailyTallies() {
    try {
        const date = new Date().toISOString().split('T')[0];
        const dailyTotal = dailyPositiveCount + dailyNegativeCount;

        await db.collection('hype_stats').insertOne({
            date,
            dailyPositiveCount,
            dailyNegativeCount,
            dailyTotal
        });

        // Reset the counters
        dailyPositiveCount = 0;
        dailyNegativeCount = 0;
    } catch (err) {
        console.error('Error recording daily tallies:', err);
    }
}

// Run resetDailyTallies at 8am PST every weekday
const job = new CronJob('0 8 * * 1-5', () => {
    resetDailyTallies();
}, null, true, 'America/Los_Angeles');

job.start();

// Timer to record moving average every `WINDOW_SIZE_MS` seconds
setInterval(() => {
    updateMessageWindow('');
}, WINDOW_SIZE_MS);

/*************************
 * TwitchJS Finalization *
 *************************/

// Listen for all public messages from users and bots
chat.on('PRIVMSG', (msg) => {
    let emote;
    if (msg.tags.emotes.length) {
        // Extract emote from indices given by emotes[0]['start'|'end']
        // ex: "emotes":[{"id":"122430","start":0,"end":7}]
        const { start, end } = msg.tags.emotes[0];
        emote = msg.message.substring(start, end + 1);
    }

    msg.channel = msg.channel.replace('#', '');

    const params = [msg.channel, msg.username, msg.message];

    // Listen for specific users or bots
    switch (msg.username) {
        case TWITCH_PREFERENCES.credentials.username:
            handleMyMessage(...params);
            break;
        default:
            handleOtherMessage(...params);
    }

    enqueueChatMessage(...params, msg.isModerator, emote);
});

// Connect to IRC
chat.connect()
    .then(() => {
        // Join channels
        for (const channel of TWITCH_PREFERENCES.channels) {
            chat.join(channel);
        }

        // Clear the console and prepare for new output
        console.clear();
        console.log(colors.greenBright('Connection established.\n'));

        startDequeueDisposalProcess();
    })
    .catch(err => {
        console.error('Error connecting to IRC:', err);
    });
