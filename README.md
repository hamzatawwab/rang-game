# Rang — Online Multiplayer Card Game

4-player online Rang (Pakistani trump card game) built with Node.js, Express, and Socket.IO.

---

## Folder Structure

```
rang-game/
├── server/
│   ├── index.js          ← Main server (Express + Socket.IO)
│   └── gameEngine.js     ← All game rules and logic
├── public/
│   ├── index.html        ← Game UI (lobby + table)
│   ├── css/
│   │   └── style.css     ← All styles
│   └── js/
│       └── app.js        ← Client-side game logic
├── package.json
└── README.md
```

---

## STEP 1 — Upload to GitHub

### 1a. Go to GitHub
- Open your browser and go to: **https://github.com**
- Sign in to your account

### 1b. Create a new repository
- Click the green **"New"** button (top left)
- Repository name: `rang-game`
- Set to **Public**
- Do NOT check "Add README"
- Click **"Create repository"**

### 1c. Upload the files
- On the new empty repo page, click **"uploading an existing file"** link
- You will see a drag-and-drop area
- Open your `rang-game` folder on your computer
- Select ALL files and folders inside it (Ctrl+A on Windows, Cmd+A on Mac)
- Drag them all into the GitHub upload area
- Wait for them to upload (you will see a list of files)
- Scroll down, type a commit message like `first upload`
- Click **"Commit changes"**
- ✅ Your code is now on GitHub

---

## STEP 2 — Deploy on Render

### 2a. Go to Render
- Open: **https://render.com**
- Sign in (you can use your GitHub account to sign in — recommended)

### 2b. Create a new Web Service
- Click **"New +"** button (top right)
- Select **"Web Service"**
- Click **"Connect a repository"**
- You will see your GitHub repos listed
- Click on **rang-game**
- Click **"Connect"**

### 2c. Configure the service
Fill in these fields exactly:

| Field | Value |
|-------|-------|
| Name | rang-game (or anything you like) |
| Region | Choose closest to you |
| Branch | main |
| Runtime | **Node** |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

- Click **"Create Web Service"**

### 2d. Wait for deployment
- Render will show a build log
- Wait until you see: **"Your service is live"** (takes 2-4 minutes)
- Your game URL will appear at the top, like: `https://rang-game-xxxx.onrender.com`

### 2e. Share with players
- Copy your URL
- All 4 players open this URL on their phones or computers
- The game starts when all 4 players have joined and chosen seats

---

## How to Play

1. **Player 1** opens the URL, enters their name, clicks "Create New Room"
2. They choose a seat (P1, P2, P3, or P4)
3. They copy the room link (click "📋 Copy Link") and share it with 3 friends
4. Other players open the link, enter their names, and choose available seats
5. Game starts automatically when all 4 seats are filled

---

## Game Rules Summary

- **Teams:** A = P1+P3 · B = P2+P4
- **Play order:** Counter-clockwise P1→P2→P3→P4
- **Scoring:** Normal win=1pt, Coat=2pt, Goon Coat=3pt, 5-Card Challenge=3pt, 13-Card Challenge=5pt
- **Series:** First team to 15 points wins

---

## Testing Checklist

- [ ] 4 players can join the same room
- [ ] Seats show player names correctly
- [ ] Dealer selection animation shows correctly
- [ ] Rang selector can take top 5 or cut
- [ ] All 4 players receive their 5 initial cards
- [ ] 5-card challenge button appears only for non-rang team
- [ ] Partner cards viewable during challenge pending phase
- [ ] Accept/Reject challenge works and scores correctly
- [ ] Remaining 32 cards dealt correctly (13 each)
- [ ] 13-card challenge button appears for all 4 players
- [ ] Trick play: cards play in correct CCW order
- [ ] Illegal cards (wrong suit when you have led suit) are greyed out
- [ ] Ace rule: winning with ace → next lead with ace counts as 2
- [ ] Collection logic: same player must win 2 consecutive tricks
- [ ] Final pile: trick 13 winner scoops all remaining
- [ ] Scores update correctly: Normal / Coat / Goon Coat
- [ ] Series ends at 15 points
- [ ] Disconnected player waits 3 minutes before timeout
- [ ] Game works on iPhone Safari and Android Chrome

---

## Notes on Render Free Tier

- The free Render instance **sleeps after 15 minutes of inactivity**
- When someone first opens the URL after sleep, it takes **~30-60 seconds** to wake up
- Once awake, it works perfectly for all 4 players
- To avoid this, upgrade to Render's paid tier ($7/month) for always-on hosting

---

## Support

If something goes wrong during deployment, the most common fixes are:
1. Make sure the folder structure matches exactly (server/ and public/ folders inside rang-game/)
2. Make sure `package.json` is at the root of the uploaded folder
3. On Render, make sure Start Command is `npm start` and Build Command is `npm install`
