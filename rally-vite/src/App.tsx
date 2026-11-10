import rallyLogo from './assets/rally-logo.png'
import { useEffect, useMemo, useState } from 'react'
import './App.css'

type Game = {
  id: number
  name: string
  sport: string
  date: string
  location: string
  skill: string
  spots: number
  age: string
  host: string
}

const initialGames: Game[] = [
  {
    id: 1,
    name: 'Evening Basketball Run',
    sport: 'Basketball',
    date: 'Today · 5:00 PM',
    location: 'Community Sports Court',
    skill: 'Intermediate',
    spots: 3,
    age: '15–17',
    host: 'Alex M.',
  },
  {
    id: 2,
    name: 'Weekend Football',
    sport: 'Football',
    date: 'Tomorrow · 9:00 AM',
    location: 'Riverside Football Ground',
    skill: 'Beginner',
    spots: 5,
    age: '13–18',
    host: 'Sam R.',
  },
  {
    id: 3,
    name: 'Badminton Doubles',
    sport: 'Badminton',
    date: 'Saturday · 4:00 PM',
    location: 'Indoor Sports Centre',
    skill: 'Intermediate',
    spots: 2,
    age: '15–17',
    host: 'Jamie K.',
  },
  {
    id: 4,
    name: 'Tennis Practice',
    sport: 'Tennis',
    date: 'Sunday · 7:00 AM',
    location: 'Public Tennis Courts',
    skill: 'Advanced',
    spots: 1,
    age: '17–19',
    host: 'Taylor P.',
  },
]

const sports = ['All sports', 'Basketball', 'Football', 'Badminton', 'Tennis']
const skills = ['Any level', 'Beginner', 'Intermediate', 'Advanced']
const gameSkills = ['All levels', 'Beginner', 'Intermediate', 'Advanced']
const gameStorageKey = 'rally-game-state-v1'

type SavedGameState = {
  games: Game[]
  joinedGames: number[]
}

function isGame(value: unknown): value is Game {
  if (typeof value !== 'object' || value === null) return false

  const game = value as Record<string, unknown>
  return (
    typeof game.id === 'number' &&
    typeof game.name === 'string' &&
    typeof game.sport === 'string' &&
    typeof game.date === 'string' &&
    typeof game.location === 'string' &&
    typeof game.skill === 'string' &&
    typeof game.spots === 'number' &&
    Number.isFinite(game.spots) &&
    game.spots >= 0 &&
    typeof game.age === 'string' &&
    typeof game.host === 'string'
  )
}

function isSavedGameState(value: unknown): value is SavedGameState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'games' in value &&
    Array.isArray(value.games) &&
    value.games.every(isGame) &&
    'joinedGames' in value &&
    Array.isArray(value.joinedGames) &&
    value.joinedGames.every((id) => typeof id === 'number')
  )
}

function loadSavedGameState(): SavedGameState {
  if (typeof window === 'undefined') return { games: initialGames, joinedGames: [] }

  try {
    const savedState = window.localStorage.getItem(gameStorageKey)
    if (!savedState) return { games: initialGames, joinedGames: [] }

    const parsed: unknown = JSON.parse(savedState)
    if (!isSavedGameState(parsed)) {
      console.error('Saved game data is invalid; using the default games.')
      return { games: initialGames, joinedGames: [] }
    }

    return {
      games: parsed.games,
      joinedGames: parsed.joinedGames.filter((id) =>
        parsed.games.some((game) => game.id === id),
      ),
    }
  } catch (error) {
    console.error('Could not load saved game data.', error)
    return { games: initialGames, joinedGames: [] }
  }
}

function App() {
  const [savedGameState] = useState(loadSavedGameState)
  const [games, setGames] = useState<Game[]>(savedGameState.games)
  const [joinedGames, setJoinedGames] = useState<number[]>(savedGameState.joinedGames)
  const [sport, setSport] = useState('All sports')
  const [skill, setSkill] = useState('Any level')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [newGame, setNewGame] = useState({
    name: '',
    sport: 'Basketball',
    date: '',
    location: '',
    skill: 'Beginner',
    spots: '4',
    age: '13–18',
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(
        gameStorageKey,
        JSON.stringify({ games, joinedGames }),
      )
    } catch (error) {
      console.error('Could not save game data.', error)
    }
  }, [games, joinedGames])

  const filteredGames = useMemo(() => {
    return games.filter((game) => {
      const matchesSport = sport === 'All sports' || game.sport === sport
      const matchesSkill =
        skill === 'Any level' || game.skill === 'All levels' || game.skill === skill
      const term = search.toLowerCase()
      const matchesSearch =
        game.name.toLowerCase().includes(term) ||
        game.location.toLowerCase().includes(term) ||
        game.sport.toLowerCase().includes(term)

      return matchesSport && matchesSkill && matchesSearch
    })
  }, [games, sport, skill, search])

  function requestToJoin(game: Game) {
    if (game.spots <= 0 || joinedGames.includes(game.id)) return

    setGames((previous) =>
      previous.map((currentGame) =>
        currentGame.id === game.id && currentGame.spots > 0
          ? { ...currentGame, spots: currentGame.spots - 1 }
          : currentGame,
      ),
    )
    setJoinedGames((previous) => [...previous, game.id])
    setNotice(`You joined "${game.name}".`)
  }

  function leaveGame(game: Game) {
    if (!joinedGames.includes(game.id)) return

    setGames((previous) =>
      previous.map((currentGame) =>
        currentGame.id === game.id
          ? { ...currentGame, spots: currentGame.spots + 1 }
          : currentGame,
      ),
    )
    setJoinedGames((previous) => previous.filter((id) => id !== game.id))
    setNotice(`You left "${game.name}".`)
  }

  function publishGame(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const game: Game = {
      id: Date.now(),
      name: newGame.name.trim(),
      sport: newGame.sport,
      date: newGame.date || 'Time to be confirmed',
      location: newGame.location.trim(),
      skill: newGame.skill,
      spots: Number(newGame.spots),
      age: newGame.age,
      host: 'You',
    }

    setGames((previous) => [game, ...previous])
    setSport('All sports')
    setSkill('Any level')
    setSearch('')
    setShowCreate(false)
    setNotice(`"${game.name}" has been added to the demo games list.`)

    setNewGame({
      name: '',
      sport: 'Basketball',
      date: '',
      location: '',
      skill: 'Beginner',
      spots: '4',
      age: '13–18',
    })
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800;900&family=Manrope:wght@400;500;600;700;800&display=swap');

        :root {
          font-family: 'Manrope', sans-serif;
          color: #f3f8ff;
          background: #071a35;
          font-synthesis: none;
          text-rendering: optimizeLegibility;
          --navy: #071a35;
          --panel: #0d223d;
          --cyan: #7dc9e6;
          --muted: #bed2e9;
          --border: #27476d;
        }

        * { box-sizing: border-box; }
        body { margin: 0; min-width: 320px; background: var(--navy); }
        button, input, select { font: inherit; }
        button { cursor: pointer; }
        button:focus-visible, input:focus-visible, select:focus-visible {
          outline: 2px solid var(--cyan); outline-offset: 3px;
        }

        .topbar {
          min-height: 78px; padding: 0 6%;
          display: flex; align-items: center; justify-content: space-between;
          gap: 20px; border-bottom: 1px solid var(--border);
          background: #071b37;
        }
        .brand {
          display: flex; align-items: center; gap: 10px;
          color: white; font-size: 28px; font-weight: 900;
          letter-spacing: -1.5px; text-decoration: none;
        }
        .brand-mark {
          display: grid; place-items: center; width: 40px; height: 40px;
          color: var(--cyan); border: 2px solid var(--cyan);
          border-radius: 12px; font-size: 22px; transform: skew(-5deg);
        }
        .navlinks { display: flex; align-items: center; gap: 27px; }
        .navlinks button {
          color: #c6d8ed; background: none; border: 0; font-size: 13px;
          font-weight: 700;
        }
        .navlinks button:hover { color: var(--cyan); }
        .profile {
          border: 1px solid #234365; border-radius: 30px; padding: 11px 17px;
          color: white; background: #0b2342; font-weight: 800;
        }
        main { width: min(1240px, 95%); margin: 28px auto 60px; }
        .hero {
          position: relative; overflow: hidden; padding: 44px 36px 38px;
          border-radius: 25px;
          background: linear-gradient(115deg, #0a1f3a 0%, #122e4f 42%, #184669 100%);
          border: 1px solid rgba(125, 201, 230, 0.18);
          box-shadow: 0 16px 32px rgba(2, 11, 23, 0.2);
          filter: saturate(0.9) brightness(0.96);
        }
        .hero::after {
          content: 'R'; position: absolute; right: 8%; top: -100px;
          font: 900 330px 'Barlow Condensed', sans-serif;
          color: rgba(255, 255, 255, 0.06); pointer-events: none;
        }
        .eyebrow {
          color: #49ddff; font-size: 12px; font-weight: 900;
          letter-spacing: 2.2px; text-transform: uppercase;
        }
        h1, h2, h3, p { margin-top: 0; }
        .hero h1 {
          position: relative; z-index: 1; max-width: 760px;
          margin: 18px 0 14px;
          font: 900 clamp(42px, 5vw, 68px)/0.94 'Barlow Condensed', sans-serif;
          text-transform: uppercase; letter-spacing: -1.8px;
        }
        .hero p { color: #c1d4e9; font-size: 15px; line-height: 1.8; margin-bottom: 0; max-width: 620px; }
        .hero-note {
          position: absolute; right: 30px; bottom: 28px; z-index: 1;
          padding: 14px 18px; border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(8, 18, 29, 0.25);
          color: #edf6ff; font-weight: 800; font-size: 13px;
          backdrop-filter: blur(6px);
        }
        .layout {
          display: grid; grid-template-columns: 290px minmax(0, 1fr);
          gap: 24px; margin-top: 27px; align-items: start;
        }
        .panel {
          background: var(--panel); border: 1px solid var(--border);
          border-radius: 17px; padding: 21px;
        }
        .panel h2 {
          font: 800 25px 'Barlow Condensed', sans-serif;
          text-transform: uppercase; margin-bottom: 6px;
        }
        .muted { color: var(--muted); font-size: 12px; line-height: 1.7; }
        .field { display: block; margin-top: 20px; }
        .field label {
          display: block; margin-bottom: 8px; color: #b8cde2;
          font-size: 11px; font-weight: 900; letter-spacing: .6px;
          text-transform: uppercase;
        }
        .field input, .field select {
          width: 100%; min-height: 43px; padding: 10px 12px;
          border: 1px solid #31516f; border-radius: 9px;
          color: #f3f8ff; background: #071a35;
        }
        .field input::placeholder { color: #7996b5; }
        .primary, .secondary {
          border: 0; border-radius: 10px; padding: 12px 15px;
          font-weight: 900; font-size: 12px;
        }
        .primary {
          color: #061a35; background: linear-gradient(110deg, #08b9f0, #54e5ce);
        }
        .primary:hover { filter: brightness(1.08); }
        .secondary {
          color: #d7f6ff; background: #123455; border: 1px solid #315879;
        }
        .full { width: 100%; margin-top: 20px; }
        .result-head {
          display: flex; justify-content: space-between; align-items: center;
          gap: 12px; margin-bottom: 16px;
        }
        .result-head h2 {
          font: 800 29px 'Barlow Condensed', sans-serif;
          text-transform: uppercase; margin: 0;
        }
        .count { color: var(--muted); font-size: 12px; }
        .notice {
          padding: 12px 15px; margin-bottom: 14px;
          border: 1px solid #087fa8; border-radius: 10px;
          color: #b6f1ff; background: #0b3555; font-size: 12px;
        }
        .cards { display: grid; gap: 14px; }
        .game {
          display: grid; grid-template-columns: minmax(0, 1fr) auto;
          gap: 14px; padding: 19px; border: 1px solid var(--border);
          border-left: 4px solid var(--cyan); border-radius: 15px;
          background: #0b2342; transition: transform .15s, border-color .15s;
        }
        .game:hover { transform: translateY(-2px); border-color: #1875a1; }
        .sportline { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .sport-icon {
          display: grid; place-items: center; width: 43px; height: 43px;
          border-radius: 12px; background: #123c5d; font-size: 22px;
        }
        .sport-label {
          color: var(--muted); font-size: 10px; font-weight: 900;
          letter-spacing: 1px; text-transform: uppercase;
        }
        .game h3 {
          margin-bottom: 10px; font: 800 25px 'Barlow Condensed', sans-serif;
        }
        .details {
          display: grid; gap: 7px; margin: 0 0 14px;
          color: #b8cde2; font-size: 12px;
        }
        .chips { display: flex; flex-wrap: wrap; gap: 7px; }
        .chip {
          padding: 6px 9px; border-radius: 6px;
          color: #d9f5ff; background: #123455; font-size: 10px; font-weight: 800;
        }
        .chip.purple { color: #d8d0ff; background: #302c59; }
        .host { margin-top: 14px; color: var(--muted); font-size: 11px; }
        .game-side {
          display: flex; flex-direction: column; justify-content: space-between;
          align-items: flex-end; gap: 15px;
        }
        .spots {
          padding: 7px 9px; border-radius: 7px; white-space: nowrap;
          color: #a9f0ff; background: #123c5d; font-size: 10px; font-weight: 900;
        }
        .game-actions { display: flex; flex-direction: column; gap: 8px; }
        .join { min-width: 125px; }
        .join:disabled { cursor: not-allowed; opacity: .55; }
        .empty {
          padding: 32px 20px; border: 1px dashed #315879;
          border-radius: 14px; text-align: center; color: var(--muted);
        }
        .empty h3 { color: white; font-size: 18px; }
        .safety {
          display: flex; gap: 13px; padding: 17px; margin-top: 18px;
          border: 1px solid var(--border); border-radius: 14px;
          background: linear-gradient(110deg, #0b3555, #0b2342);
        }
        .safety-icon { font-size: 23px; }
        .safety strong { font-size: 12px; }
        .safety p { margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 1.7; }
        .footer { margin-top: 24px; color: #7996b5; text-align: center; font-size: 10px; }
        .overlay {
          position: fixed; inset: 0; z-index: 10; display: grid;
          place-items: center; padding: 18px; background: #020b18d9;
          overflow-y: auto;
        }
        .modal {
          width: min(520px, 100%); padding: 24px;
          border: 1px solid #315879; border-radius: 18px; background: #0b2342;
        }
        .modal-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
        .modal h2 { font: 800 30px 'Barlow Condensed', sans-serif; margin: 8px 0; }
        .modal .field { margin-top: 15px; }
        .modal-actions { display: flex; gap: 10px; margin-top: 20px; }
        .modal-actions button { flex: 1; }
        .close {
          width: 35px; height: 35px; border-radius: 9px;
          border: 1px solid var(--border); color: white; background: #123455;
        }
        .two-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media(max-width: 850px) {
          .topbar { padding: 16px 4%; flex-wrap: wrap; }
          .navlinks { order: 3; width: 100%; justify-content: center; gap: 16px; flex-wrap: wrap; }
          .layout { grid-template-columns: 1fr; }
          .hero-note { position: relative; display: inline-block; right: auto; bottom: auto; margin-top: 22px; }
        }
        @media(max-width: 500px) {
          main { width: 94%; margin-top: 18px; }
          .hero { padding: 25px 20px; }
          .hero h1 { font-size: 43px; }
          .game { grid-template-columns: 1fr; }
          .game-side { flex-direction: row; align-items: center; }
          .join { min-width: 125px; }
          .result-head { align-items: flex-start; flex-direction: column; }
          .two-cols { grid-template-columns: 1fr; }
          .profile { padding: 9px 12px; }
        }
      `}</style>

      <header className="topbar">
       <a href="#home" className="brand" aria-label="RALLY home">
  <img src={rallyLogo} alt="" />
  RALLY
</a>

        <nav className="navlinks" aria-label="Main navigation">
          <button onClick={() => document.getElementById('games')?.scrollIntoView({ behavior: 'smooth' })}>
            Find a game
          </button>
          <button onClick={() => setShowCreate(true)}>Create a game</button>
          <button onClick={() => document.getElementById('safety')?.scrollIntoView({ behavior: 'smooth' })}>
            Safety
          </button>
          <button onClick={() => setNotice('Find a game, check its details, and join if spots are available. This is currently a front-end demo.')}>
            How it works
          </button>
        </nav>

        <button className="profile" onClick={() => setShowProfile(true)}>
          Your profile ↗
        </button>
      </header>

      <main id="home">
        <section className="hero">
          <h1>Find your people.<br />Play more.</h1>
          <p>
            Discover games that fit your sport, schedule, and skill level.
            <br />Review the details, then join if there is an available spot.
          </p>
          <div className="hero-note">⚡ More games. Better crew.</div>
        </section>

        <div className="layout">
          <aside className="panel">
            <h2>Find your game</h2>
            <p className="muted">Filter the games to find the right match.</p>

            <div className="field">
              <label htmlFor="search">Search games</label>
              <input
                id="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Sport, game, or area..."
              />
            </div>

            <div className="field">
              <label htmlFor="sport">Sport</label>
              <select id="sport" value={sport} onChange={(event) => setSport(event.target.value)}>
                {sports.map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>

            <div className="field">
              <label htmlFor="skill">Skill level</label>
              <select id="skill" value={skill} onChange={(event) => setSkill(event.target.value)}>
                {skills.map((item) => <option key={item}>{item}</option>)}
              </select>
            </div>

            <button
              className="secondary full"
              onClick={() => { setSport('All sports'); setSkill('Any level'); setSearch(''); setNotice('Filters cleared.') }}
            >
              Clear filters
            </button>

            <button className="primary full" onClick={() => setShowCreate(true)}>
              + Create a game
            </button>
          </aside>

          <section id="games">
            <div className="result-head">
              <div>
                <div className="eyebrow">Your next match</div>
                <h2>Games near you</h2>
              </div>
              <div className="count">{filteredGames.length} games found</div>
            </div>

            {notice && (
              <div className="notice" role="status">
                {notice}
                <button
                  aria-label="Dismiss message"
                  onClick={() => setNotice('')}
                  style={{ float: 'right', border: 0, background: 'transparent', color: 'inherit' }}
                >
                  ✕
                </button>
              </div>
            )}

            {filteredGames.length === 0 ? (
              <div className="empty">
                <div style={{ fontSize: 32, marginBottom: 12 }}>
                  {games.length === 0 ? '🏟️' : '🔎'}
                </div>
                <h3>{games.length === 0 ? 'No games available' : 'No games found'}</h3>
                <p>
                  {games.length === 0
                    ? 'There are no games available right now. Create one to get started.'
                    : 'Try changing your filters or create a game of your own.'}
                </p>
                {games.length === 0 ? (
                  <button className="primary" onClick={() => setShowCreate(true)}>
                    + Create a game
                  </button>
                ) : (
                  <button
                    className="secondary"
                    onClick={() => { setSport('All sports'); setSkill('Any level'); setSearch('') }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div className="cards">
                {filteredGames.map((game) => {
                  const joined = joinedGames.includes(game.id)
                  const icon: Record<string, string> = {
                    Basketball: '🏀',
                    Football: '⚽',
                    Badminton: '🏸',
                    Tennis: '🎾',
                  }

                  return (
                    <article className="game" key={game.id}>
                      <div>
                        <div className="sportline">
                          <div className="sport-icon">{icon[game.sport] ?? '🏆'}</div>
                          <div className="sport-label">{game.sport}</div>
                        </div>

                        <h3>{game.name}</h3>

                        <div className="details">
                          <span>◷ {game.date}</span>
                          <span>⌖ {game.location}</span>
                        </div>

                        <div className="chips">
                          <span className="chip">{game.skill}</span>
                          <span className="chip purple">Ages {game.age}</span>
                        </div>

                        <div className="host">Organized by {game.host}</div>
                      </div>

                      <div className="game-side">
                        <span className="spots">
                          {game.spots > 0 ? `${game.spots} spots left` : 'Game full'}
                        </span>
                        <div className="game-actions">
                          <button
                            className={`primary join ${joined ? 'secondary' : ''}`}
                            disabled={game.spots <= 0 || joined}
                            onClick={() => requestToJoin(game)}
                          >
                            {joined ? 'Joined' : game.spots <= 0 ? 'Game full' : 'Join game →'}
                          </button>
                          {joined && (
                            <button className="secondary join" onClick={() => leaveGame(game)}>
                              Leave game
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}

            <section className="safety" id="safety">
              <div className="safety-icon">🛡️</div>
              <div>
                <strong>Play smart. Look out for each other.</strong>
                <p>Meet at appropriate public sports venues, protect your personal information, and tell a trusted adult about anything that feels unsafe. Safety features and participant verification are not implemented in this demo.</p>
              </div>
            </section>

            <footer className="footer">
              RALLY · Find your people. Play your sport. · Front-end prototype
            </footer>
          </section>
        </div>
      </main>

      {showCreate && (
        <div className="overlay" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowCreate(false)
        }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">Bring players together</div>
                <h2 id="create-title">Create a game</h2>
                <p className="muted">Add your game to the current demo list.</p>
              </div>
              <button className="close" onClick={() => setShowCreate(false)} aria-label="Close form">✕</button>
            </div>

            <form onSubmit={publishGame}>
              <div className="field">
                <label htmlFor="game-name">Game name</label>
                <input id="game-name" required maxLength={70} value={newGame.name}
                  onChange={(event) => setNewGame({ ...newGame, name: event.target.value })}
                  placeholder="e.g. Sunday basketball" />
              </div>

              <div className="two-cols">
                <div className="field">
                  <label htmlFor="new-sport">Sport</label>
                  <select id="new-sport" value={newGame.sport}
                    onChange={(event) => setNewGame({ ...newGame, sport: event.target.value })}>
                    {sports.slice(1).map((item) => <option key={item}>{item}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="new-skill">Skill level</label>
                  <select id="new-skill" value={newGame.skill}
                    onChange={(event) => setNewGame({ ...newGame, skill: event.target.value })}>
                    {gameSkills.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="new-date">Date and time</label>
                <input id="new-date" required type="datetime-local" value={newGame.date}
                  onChange={(event) => setNewGame({ ...newGame, date: event.target.value })} />
              </div>

              <div className="field">
                <label htmlFor="new-location">Public venue or general area</label>
                <input id="new-location" required maxLength={100} value={newGame.location}
                  onChange={(event) => setNewGame({ ...newGame, location: event.target.value })}
                  placeholder="Sports centre or public court" />
              </div>

              <div className="two-cols">
                <div className="field">
                  <label htmlFor="new-spots">Open spots</label>
                  <select id="new-spots" value={newGame.spots}
                    onChange={(event) => setNewGame({ ...newGame, spots: event.target.value })}>
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((item) => (
                      <option key={item} value={item}>{item} spots</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="new-age">Age group</label>
                  <select id="new-age" value={newGame.age}
                    onChange={(event) => setNewGame({ ...newGame, age: event.target.value })}>
                    <option>13–15</option>
                    <option>15–17</option>
                    <option>13–18</option>
                    <option>17–19</option>
                  </select>
                </div>
              </div>

              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setShowCreate(false)}>Cancel</button>
                <button type="submit" className="primary">Publish game →</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {showProfile && (
        <div className="overlay" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowProfile(false)
        }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
            <div className="modal-head">
              <div>
                <div className="eyebrow">Player space</div>
                <h2 id="profile-title">Your profile</h2>
              </div>
              <button className="close" onClick={() => setShowProfile(false)} aria-label="Close profile">✕</button>
            </div>
            <p className="muted">Profile and account creation will be connected when authentication is added.</p>
            <div className="modal-actions">
              <button className="primary" onClick={() => setShowProfile(false)}>Got it</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

export default App
