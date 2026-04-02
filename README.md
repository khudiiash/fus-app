# ⚡ FUSAPP — Gamified School Rewards Platform

A mobile-first PWA where students earn coins, trade items, customize avatars, and level up. Teachers award points. Admins manage everything.

## Tech Stack

- **Vue 3** + Composition API + Vite
- **Firebase** (Auth, Firestore, Hosting)
- **Pinia** state management
- **Tailwind CSS v4** (dark game theme)
- **GSAP** animations
- **VitePWA** — installable on mobile

---

## Setup

### 1. Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create a new project
3. Enable **Authentication** → Email/Password sign-in
4. Enable **Firestore** in production mode
5. Copy your config from Project Settings → Web App

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in your Firebase config:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

### 3. Deploy Firestore Rules & Indexes

```bash
npm install -g firebase-tools
firebase login
firebase init   # select Firestore, Hosting
firebase deploy --only firestore:rules,firestore:indexes
```

### 4. Create Admin Account

In Firebase Console → Authentication → Add User manually:
- Email: your admin address (e.g. `admin@your-school.example`)
- Password: a **strong password** (only in Firebase Auth — not the same thing as the login access code below)

Then in Firestore, create `users/{uid}` with (example access code `ADMIN-1000` — pick your own in production):
```json
{
  "displayName": "Admin",
  "email": "admin@your-school.example",
  "role": "admin",
  "accessCode": "ADMIN-1000",
  "coins": 0, "xp": 0, "level": 1, "streak": 0,
  "avatar": { "skinId": "default", "backgroundId": "default", "frameId": "none", "accessories": [] },
  "inventory": [], "badges": []
}
```

And a matching document `accessCodes/ADMIN-1000`:
```json
{
  "email": "admin@your-school.example",
  "uid": "<admin uid>",
  "displayName": "Admin",
  "role": "admin",
  "isActive": true
}
```

If you ever published a different admin access code, **rotate it in Firestore**: update `accessCode` on the admin user, create the new `accessCodes/{CODE}` document, delete the old `accessCodes` document, and do not commit real codes to git.

### 5. Install & Run

```bash
npm install
npm run dev
```

### 6. Seed Default Data

Log in as admin → Dashboard → click **"Seed Now"** to populate shop items and achievements.

---

## User Flows

### Admin
- Login with your admin access code (example in setup above: `ADMIN-1000`)
- Create classes, students, teachers
- Manage shop items (add/edit/delete)
- See overview stats and top students

### Teacher
- Login with teacher access code (e.g. `TEACH-4821`)
- View assigned classes
- Award coins to individual students or whole class
- View award history

### Student
- Login with student access code (e.g. `WOLF-4821`)
- See daily quests, login streak, coin balance
- Visit Shop to buy avatar items
- Customize avatar in Profile
- Trade coins/items with classmates
- Compete on Leaderboard
- Unlock Achievement badges

---

## Gamification Systems

| System | Description |
|--------|-------------|
| 🪙 Coins | Main currency; given by teachers; used in shop & trading |
| ⭐ XP + Levels | Earned by logins, coins, trades; 50 levels total |
| 🔥 Streak | Daily login streak; bonus coins at 3/7/14/30 days |
| ⚡ Daily Quests | 3 quests/day, reset at midnight |
| 🏅 Achievements | Milestone badges with coin/XP rewards |
| 🎨 Avatar | Skin, background, frame, accessories — all unlockable |
| 🤝 Trading | Student-to-student coin + item offers |
| 🏆 Leaderboard | Class + school rankings by coins/XP/streak |

---

## Project Structure

```
src/
├── firebase/
│   ├── config.js          Firebase init
│   ├── collections.js     All Firestore + game logic helpers
│   └── seedData.js        Default shop items + achievements
├── router/index.js        Routes + role guards
├── stores/
│   ├── auth.js            Auth state, login, createUserAccount
│   ├── user.js            Profile helpers, quests, equip items
│   ├── shop.js            Shop items, purchase
│   └── trade.js           Trade offers, realtime listeners
├── composables/
│   ├── useToast.js        Global toast notifications
│   ├── useHaptic.js       Vibration API
│   ├── useGameification.js XP/level/streak computed
│   └── useCoinRain.js     GSAP coin rain effect
├── components/
│   ├── ui/                Button, Card, Modal, Input, Badges, Skeleton
│   ├── avatar/            AvatarDisplay, AvatarBuilder
│   └── gamification/      XPBar, CoinDisplay, StreakWidget, QuestCard, LevelUpModal
├── views/
│   ├── auth/LoginView.vue
│   ├── admin/             Dashboard, Classes, Students, Teachers, Shop
│   ├── teacher/           Dashboard, ClassView (award coins), History
│   └── student/           Home, Profile, Shop, Trade, Leaderboard, Achievements
└── layouts/               AdminLayout, TeacherLayout, StudentLayout
```

---

## Build & Deploy

```bash
npm run build          # Build for production
npm run generate-icons # Regenerate PWA icons
firebase deploy        # Deploy to Firebase Hosting
```
