
const supabase = window.rallySupabase

if (!supabase) {
  console.error('RALLY: Supabase bridge not found.')
} else {
  const style = document.createElement('style')
  style.textContent = `
    #rallyAuthBackdrop {
      position: fixed; inset: 0; z-index: 9999;
      display: none; align-items: center; justify-content: center;
      padding: 20px; background: rgba(2, 10, 25, .78);
      backdrop-filter: blur(8px);
    }
    #rallyAuthBackdrop.open { display: flex; }
    #rallyAuthPanel {
      width: 100%; max-width: 430px; padding: 28px;
      border: 1px solid #23466b; border-radius: 22px;
      background: #0b203b; color: #f4f8ff;
      font-family: Manrope, system-ui, sans-serif;
      box-shadow: 0 25px 80px #0008;
    }
    #rallyAuthPanel * { box-sizing: border-box; }
    #rallyAuthPanel h2 { margin: 0 0 8px; font-size: 27px; }
    #rallyAuthPanel p { color: #a9bfd8; line-height: 1.5; }
    #rallyAuthPanel label {
      display: block; margin: 14px 0 6px;
      font-size: 13px; font-weight: 700;
    }
    #rallyAuthPanel input {
      width: 100%; padding: 12px; border-radius: 10px;
      border: 1px solid #385575; background: #07172d;
      color: white; font: inherit;
    }
    #rallyAuthPanel button {
      cursor: pointer; border-radius: 10px; padding: 12px 15px;
      font: inherit; font-weight: 700;
    }
    #rallyAuthSubmit {
      width: 100%; margin-top: 20px; border: 0;
      background: #16c6e8; color: #04182c;
    }
    #rallyAuthClose, #rallyAuthSwitch {
      border: 1px solid #385575; background: transparent;
      color: #eaf4ff;
    }
    #rallyAuthClose { float: right; }
    #rallyAuthSwitch { width: 100%; margin-top: 10px; }
    #rallyAuthMessage {
      display: none; margin-top: 14px; padding: 10px;
      border-radius: 9px; background: #123650;
      overflow-wrap: anywhere;
    }
    #rallyAuthMessage.show { display: block; }
  `
  document.head.appendChild(style)

  const backdrop = document.createElement('div')
  backdrop.id = 'rallyAuthBackdrop'
  backdrop.innerHTML = `
    <section id="rallyAuthPanel" role="dialog"
      aria-modal="true" aria-labelledby="rallyAuthTitle">
      <button id="rallyAuthClose" type="button">Close ✕</button>
      <div style="color:#36d9ed;font-weight:800;letter-spacing:2px">
        RALLY
      </div>
      <h2 id="rallyAuthTitle">Welcome back</h2>
      <p id="rallyAuthSubtitle">Sign in to your player account.</p>
      <form id="rallyAuthForm">
        <div id="rallyAuthNameWrap" hidden>
          <label for="rallyAuthName">Display name</label>
          <input id="rallyAuthName" maxlength="60" autocomplete="nickname">
        </div>
        <label for="rallyAuthEmail">Email</label>
        <input id="rallyAuthEmail" type="email"
          autocomplete="email" required>
        <label for="rallyAuthPassword">Password</label>
        <input id="rallyAuthPassword" type="password"
          minlength="8" autocomplete="current-password" required>
        <button id="rallyAuthSubmit" type="submit">Sign in</button>
      </form>
      <button id="rallyAuthSwitch" type="button">
        New to RALLY? Create an account
      </button>
      <div id="rallyAuthMessage" role="status" aria-live="polite"></div>
    </section>
  `
  document.body.appendChild(backdrop)

  const $ = id => document.getElementById(id)
  let mode = 'signin'

  function message(text) {
    $('rallyAuthMessage').textContent = text
    $('rallyAuthMessage').classList.add('show')
  }

  function setMode(nextMode) {
    mode = nextMode
    $('rallyAuthTitle').textContent =
      mode === 'signup' ? 'Join RALLY' : 'Welcome back'
    $('rallyAuthSubtitle').textContent =
      mode === 'signup'
        ? 'Create your player account.'
        : 'Sign in to your player account.'
    $('rallyAuthNameWrap').hidden = mode !== 'signup'
    $('rallyAuthName').required = mode === 'signup'
    $('rallyAuthPassword').autocomplete =
      mode === 'signup' ? 'new-password' : 'current-password'
    $('rallyAuthSubmit').textContent =
      mode === 'signup' ? 'Create account' : 'Sign in'
    $('rallyAuthSwitch').textContent =
      mode === 'signup'
        ? 'Already have an account? Sign in'
        : 'New to RALLY? Create an account'
    $('rallyAuthMessage').classList.remove('show')
  }

  function openModal() {
    backdrop.classList.add('open')
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        message(error.message)
        return
      }

      const user = data.session?.user
      if (user) {
        $('rallyAuthTitle').textContent = 'Your profile'
        $('rallyAuthSubtitle').textContent =
          user.user_metadata?.display_name || user.email || 'Player'
        $('rallyAuthForm').hidden = true
        $('rallyAuthSwitch').textContent = 'Sign out'
        $('rallyAuthSwitch').dataset.action = 'signout'
      } else {
        $('rallyAuthForm').hidden = false
        $('rallyAuthSwitch').dataset.action = 'switch'
        setMode('signin')
      }
    })
  }

  function closeModal() {
    backdrop.classList.remove('open')
  }

  document.getElementById('profile')?.addEventListener('click', event => {
    event.preventDefault()
    openModal()
  })

  $('rallyAuthClose').addEventListener('click', closeModal)
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeModal()
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal()
  })

  $('rallyAuthSwitch').addEventListener('click', async () => {
    if ($('rallyAuthSwitch').dataset.action === 'signout') {
      const { error } = await supabase.auth.signOut()
      if (error) return message(error.message)

      $('rallyAuthForm').hidden = false
      $('rallyAuthSwitch').dataset.action = 'switch'
      setMode('signin')
      message('You have signed out.')
      return
    }

    setMode(mode === 'signin' ? 'signup' : 'signin')
  })

  $('rallyAuthForm').addEventListener('submit', async event => {
    event.preventDefault()
    const submit = $('rallyAuthSubmit')
    submit.disabled = true
    submit.textContent = 'Please wait…'
    $('rallyAuthMessage').classList.remove('show')

    try {
      const email = $('rallyAuthEmail').value.trim()
      const password = $('rallyAuthPassword').value
      let result

      if (mode === 'signup') {
        const displayName = $('rallyAuthName').value.trim()
        result = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName }
          }
        })

        if (result.error) throw result.error

        if (!result.data.session) {
          message('Account created. Check your email to confirm your address, then sign in.')
          return
        }
      } else {
        result = await supabase.auth.signInWithPassword({
          email,
          password
        })
        if (result.error) throw result.error
      }

      const user = result.data.user
      if (user) {
        const displayName =
          user.user_metadata?.display_name || user.email || 'RALLY player'

        const { error: profileError } = await supabase
          .from('profiles')
          .upsert({
            id: user.id,
            display_name: displayName
          })

        if (profileError) {
          console.error('Profile save failed:', profileError.message)
        }

        $('rallyAuthTitle').textContent = 'Welcome to RALLY!'
        $('rallyAuthSubtitle').textContent = displayName
        $('rallyAuthForm').hidden = true
        $('rallyAuthSwitch').dataset.action = 'signout'
        $('rallyAuthSwitch').textContent = 'Sign out'
        message('You are signed in.')
      }
    } catch (error) {
      message(error.message || 'Something went wrong. Please try again.')
    } finally {
      submit.disabled = false
      submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in'
    }
  })

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      $('rallyAuthForm').hidden = false
      $('rallyAuthSwitch').dataset.action = 'switch'
      setMode('signin')
    }
  })
}
