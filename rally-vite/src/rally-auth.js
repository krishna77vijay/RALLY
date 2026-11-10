
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
      max-height: calc(100vh - 40px); overflow-y: auto;
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
    #rallyAuthPanel select {
      width: 100%; padding: 12px; border-radius: 10px;
      border: 1px solid #385575; background: #07172d;
      color: white; font: inherit;
    }
    #rallyAuthPanel .rally-auth-hint {
      margin: 6px 0 0; font-size: 11px; line-height: 1.5;
    }
    #rallyProfileForm { margin-top: 20px; }
    #rallyProfileForm h3 { margin: 0 0 8px; }
    #rallyProfileSave {
      width: 100%; margin-top: 16px; border: 0;
      background: #16c6e8; color: #04182c;
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
        <div id="rallyAuthMatchingFields" hidden>
          <label for="rallyAuthAge">Age group</label>
          <select id="rallyAuthAge">
            <option value="" disabled selected>Select your age group</option>
            <option value="13–15">13–15</option>
            <option value="15–17">15–17</option>
            <option value="17–19">17–19</option>
          </select>
          <label for="rallyAuthGender">Gender</label>
          <select id="rallyAuthGender">
            <option value="" disabled selected>Select your gender</option>
            <option value="girl">Female</option>
            <option value="boy">Male</option>
            <option value="prefer_not_to_say">Prefer not to say</option>
          </select>
          <p class="rally-auth-hint">Your age group and gender appear on your player profile and determine which games you can see. Choose “Prefer not to say” to see games open to all genders.</p>
        </div>
        <label for="rallyAuthEmail">Email</label>
        <input id="rallyAuthEmail" type="email"
          autocomplete="email" required>
        <label for="rallyAuthPassword">Password</label>
        <input id="rallyAuthPassword" type="password"
          minlength="8" autocomplete="current-password" required>
        <button id="rallyAuthSubmit" type="submit">Sign in</button>
      </form>
      <form id="rallyProfileForm" hidden>
        <h3>Your matching profile</h3>
        <p id="rallyProfileHint" class="rally-auth-hint">These details appear to other players and match you with games.</p>
        <label for="rallyProfileAge">Age group</label>
        <select id="rallyProfileAge" required>
          <option value="" disabled>Select your age group</option>
          <option value="13–15">13–15</option>
          <option value="15–17">15–17</option>
          <option value="17–19">17–19</option>
        </select>
        <label for="rallyProfileGender">Gender</label>
        <select id="rallyProfileGender" required>
          <option value="" disabled>Select your gender</option>
          <option value="girl">Female</option>
          <option value="boy">Male</option>
          <option value="prefer_not_to_say">Prefer not to say</option>
        </select>
        <button id="rallyProfileSave" type="submit">Save profile</button>
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
  let profileIsAdmin = false

  function setProfileMode(isAdmin, ageGroup, gender) {
    $('rallyProfileAge').required = !isAdmin
    $('rallyProfileGender').required = !isAdmin
    $('rallyProfileAge').disabled = !isAdmin && Boolean(ageGroup)
    $('rallyProfileGender').disabled = !isAdmin && Boolean(gender)
    $('rallyProfileHint').textContent = isAdmin
      ? 'As an admin, you can leave your age group and gender blank.'
      : 'These details appear to other players and match you with games. Once saved, they cannot be changed.'
  }

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
    $('rallyAuthMatchingFields').hidden = mode !== 'signup'
    $('rallyAuthAge').required = mode === 'signup'
    $('rallyAuthGender').required = mode === 'signup'
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

  function openModal(promptText = '') {
    backdrop.classList.add('open')
    supabase.auth.getSession().then(async ({ data, error }) => {
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
        $('rallyProfileForm').hidden = false
        $('rallyAuthSwitch').textContent = 'Sign out'
        $('rallyAuthSwitch').dataset.action = 'signout'
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('age_group,gender,is_admin')
          .eq('id', user.id)
          .maybeSingle()
        if (profileError) {
          message(
            profileError.code === '42703' || /age_group|gender|is_admin/i.test(profileError.message || '')
              ? 'Your profile database columns are missing or cached. Apply 20261102002000_profile_matching_admin_access.sql in Supabase, then refresh.'
              : `Could not load your profile: ${profileError.message}`,
          )
          return
        }
        const ageGroup = profile?.age_group || user.user_metadata?.age_group || ''
        const gender = profile?.gender || user.user_metadata?.gender || ''
        $('rallyProfileAge').value = ageGroup
        $('rallyProfileGender').value = gender
        profileIsAdmin = profile?.is_admin === true
        setProfileMode(profileIsAdmin, ageGroup, gender)
      } else {
        $('rallyAuthForm').hidden = false
        $('rallyProfileForm').hidden = true
        $('rallyAuthSwitch').dataset.action = 'switch'
        setMode('signin')
        if (promptText) message(promptText)
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

  window.addEventListener('rally-auth-required', event => {
    openModal(event.detail?.message || 'Please sign in or create an account to continue.')
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
      $('rallyProfileForm').hidden = true
      $('rallyAuthSwitch').dataset.action = 'switch'
      profileIsAdmin = false
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
        const ageGroup = $('rallyAuthAge').value
        const gender = $('rallyAuthGender').value
        result = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName, age_group: ageGroup, gender }
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
        const profile = { id: user.id, display_name: displayName }
        if (user.user_metadata?.age_group) {
          profile.age_group = user.user_metadata.age_group
        }
        if (user.user_metadata?.gender) {
          profile.gender = user.user_metadata.gender
        }

        const { error: profileError } = await supabase
          .from('profiles')
          .upsert(profile)

        if (profileError) throw profileError
        const { data: savedProfile, error: savedProfileError } = await supabase
          .from('profiles')
          .select('is_admin')
          .eq('id', user.id)
          .maybeSingle()
        if (savedProfileError) throw savedProfileError

        profileIsAdmin = savedProfile?.is_admin === true
        const ageGroup = user.user_metadata?.age_group || ''
        const gender = user.user_metadata?.gender || ''
        setProfileMode(profileIsAdmin, ageGroup, gender)
        $('rallyAuthTitle').textContent = 'Welcome to RALLY!'
        $('rallyAuthSubtitle').textContent = displayName
        $('rallyAuthForm').hidden = true
        $('rallyProfileForm').hidden = false
        $('rallyProfileAge').value = ageGroup
        $('rallyProfileGender').value = gender
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

  $('rallyProfileForm').addEventListener('submit', async event => {
    event.preventDefault()
    const save = $('rallyProfileSave')
    save.disabled = true
    save.textContent = 'Saving…'
    $('rallyAuthMessage').classList.remove('show')

    try {
      const { data, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError
      const user = data.session?.user
      if (!user) throw new Error('Sign in before saving your profile.')

      const { error } = await supabase
        .from('profiles')
        .upsert({
          id: user.id,
          display_name: user.user_metadata?.display_name || user.email || 'RALLY player',
          age_group: $('rallyProfileAge').value || null,
          gender: $('rallyProfileGender').value || null
        })
      if (error) throw error

      window.dispatchEvent(new Event('rally-profile-updated'))
      const { error: metadataError } = await supabase.auth.updateUser({
        data: {
          age_group: $('rallyProfileAge').value || null,
          gender: $('rallyProfileGender').value || null
        }
      })
      if (metadataError) throw metadataError
      setProfileMode(
        profileIsAdmin,
        $('rallyProfileAge').value,
        $('rallyProfileGender').value,
      )
      message('Your profile has been saved.')
    } catch (error) {
      message(error.message || 'Could not save your profile. Please try again.')
    } finally {
      save.disabled = false
      save.textContent = 'Save profile'
    }
  })

  supabase.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') {
      $('rallyAuthForm').hidden = false
      $('rallyProfileForm').hidden = true
      $('rallyAuthSwitch').dataset.action = 'switch'
      profileIsAdmin = false
      setMode('signin')
    }
  })
}
