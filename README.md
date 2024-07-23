# NodeJS Twitch Hype Bot
A hype bot for Twitch chat.

### Getting Started
1. Clone this repository: `git clone https://github.com/knakamura13/node-js-twitch-hype-bot node-hype-bot && cd node-hype-bot`
 
2. Install Node.js for your system: https://nodejs.org/en/download/

3. Install the project dependencies: `npm install`
    - Dependencies used in this project:
``` 
       "chalk": "^5.0.1",
       "dotenv": "^16.0.3",
       "lodash": "^4.17.21",
       "sqlite3": "^5.1.2",
       "supervisor": "^0.12.0"
       "twitch-js": "^2.0.0-beta.43",
```

4. Create a file at the root of the project called `.env` and add your Twitch credentials. You can get your password (OAuth key) from http://twitchapps.com/tmi/:
```
TWITCH_USERNAME=yourusername
TWITCH_PASSWORD=yourpassword
```
    
5. Run the app: `npm start`
