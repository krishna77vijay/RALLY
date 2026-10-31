const styles = document.createElement('style')
styles.textContent = `
  .rally-reviews-privacy {
    margin: 0 0 18px; padding: 13px 15px; border: 1px solid rgba(66,217,255,.22);
    border-radius: 11px; background: rgba(66,217,255,.06); color: #b9d1e4;
    font-size: 12px; line-height: 1.65;
  }
  .rally-reviews-status { margin: 0 0 14px; color: #b9d1e4; font-size: 13px; }
  .rally-reviews-status:empty { display: none; }
  .rally-reviews-status.error { color: #ffb4b4; }
  .rally-review-targets { display: grid; gap: 14px; }
  .rally-review-card {
    padding: 18px; border: 1px solid rgba(132,177,211,.2); border-radius: 15px;
    background: #0b2342;
  }
  .rally-review-card h3 { margin: 0 0 4px; color: #f5f9ff; font-size: 17px; }
  .rally-review-game { margin: 0 0 16px; color: #91abc2; font-size: 11px; }
  .rally-review-form { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
  .rally-review-form label, .rally-review-form legend {
    color: #c3d6e8; font-size: 11px; font-weight: 800;
  }
  .rally-review-form select, .rally-review-form textarea {
    display: block; width: 100%; margin-top: 6px; padding: 10px 11px;
    border: 1px solid #31516f; border-radius: 9px; color: #f3f8ff; background: #071a35;
  }
  .rally-review-form fieldset {
    grid-column: 1 / -1; margin: 0; padding: 11px 12px;
    border: 1px solid rgba(132,177,211,.2); border-radius: 10px;
  }
  .rally-review-safety-options { display: flex; gap: 18px; margin-top: 9px; }
  .rally-review-safety-options label { display: flex; align-items: center; gap: 7px; }
  .rally-review-form input[type="radio"] { accent-color: #42d9ff; }
  .rally-review-form .rally-review-note { grid-column: 1 / -1; }
  .rally-review-note small { display: block; margin-top: 5px; color: #91abc2; font-size: 10px; line-height: 1.5; }
  .rally-review-form textarea { min-height: 76px; resize: vertical; }
  .rally-review-submit { grid-column: 1 / -1; justify-self: start; min-width: 150px; }
  .rally-review-submit:disabled { cursor: wait; opacity: .6; }
  .rally-review-empty {
    padding: 28px 20px; border: 1px dashed rgba(132,177,211,.3);
    border-radius: 14px; color: #b9d1e4; text-align: center; font-size: 13px; line-height: 1.6;
  }
  @media(max-width:600px) {
    .rally-review-form { grid-template-columns: 1fr; }
    .rally-review-submit { width: 100%; }
  }
`
document.head.append(styles)

const status = document.getElementById('rallyReviewsStatus')
const targetsRoot = document.getElementById('rallyReviewTargets')
const reviewsPanel = document.getElementById('socialReviewsPanel')

if (status && targetsRoot && reviewsPanel) {
  let supabase
  let authSubscription
  let loaded = false

  function setStatus(message = '', isError = false) {
    status.textContent = message
    status.classList.toggle('error', isError)
  }

  function formatDate(value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'recently'
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
  }

  function showSignIn() {
    targetsRoot.replaceChildren()
    const prompt = document.createElement('div')
    prompt.className = 'rally-review-empty'
    prompt.textContent = 'Sign in to see players from your completed games who are eligible for a review.'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'social-primary-btn'
    button.textContent = 'Sign in'
    button.addEventListener('click', () => document.getElementById('profile')?.click())
    prompt.append(' ', button)
    targetsRoot.append(prompt)
  }

  function createRatingField(labelText, name) {
    const label = document.createElement('label')
    label.textContent = labelText
    const select = document.createElement('select')
    select.name = name
    select.required = true
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = 'Choose a rating'
    placeholder.disabled = true
    placeholder.selected = true
    select.append(placeholder)
    const descriptions = {
      1: 'Needs improvement',
      2: 'Below expectations',
      3: 'Solid',
      4: 'Strong',
      5: 'Excellent',
    }
    for (let rating = 1; rating <= 5; rating += 1) {
      const option = document.createElement('option')
      option.value = String(rating)
      option.textContent = `${rating} / 5 — ${descriptions[rating]}`
      select.append(option)
    }
    label.append(select)
    return label
  }

  function renderTargets(targets) {
    targetsRoot.replaceChildren()
    if (!targets.length) {
      const empty = document.createElement('div')
      empty.className = 'rally-review-empty'
      empty.textContent = 'No reviews to complete right now. After a game is confirmed complete, you can review each other attendee once.'
      targetsRoot.append(empty)
      return
    }

    for (const target of targets) {
      const card = document.createElement('article')
      card.className = 'rally-review-card'

      const heading = document.createElement('h3')
      heading.textContent = target.player_name || 'RALLY player'
      const game = document.createElement('p')
      game.className = 'rally-review-game'
      game.textContent = `Completed game · ${formatDate(target.game_completed_at)}`

      const form = document.createElement('form')
      form.className = 'rally-review-form'
      form.dataset.playerId = target.player_id
      form.dataset.gameId = target.game_id
      form.append(
        createRatingField('Skill', 'skill'),
        createRatingField('Attitude', 'attitude'),
        createRatingField('Sportsmanship', 'sportsmanship'),
        createRatingField('Reliability', 'reliability'),
      )

      const safety = document.createElement('fieldset')
      const legend = document.createElement('legend')
      legend.textContent = 'Did you feel safe playing with this person?'
      const options = document.createElement('div')
      options.className = 'rally-review-safety-options'
      for (const [value, text] of [['true', 'Yes'], ['false', 'No']]) {
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = 'radio'
        input.name = `felt-safe-${target.player_id}`
        input.value = value
        input.required = true
        label.append(input, document.createTextNode(text))
        options.append(label)
      }
      safety.append(legend, options)
      form.append(safety)

      const noteLabel = document.createElement('label')
      noteLabel.className = 'rally-review-note'
      noteLabel.append(document.createTextNode('Private safety context (optional)'))
      const note = document.createElement('textarea')
      note.name = 'privateSafetyNote'
      note.maxLength = 500
      note.placeholder = 'Share relevant context for RALLY moderators. Do not include contact details.'
      const hint = document.createElement('small')
      hint.textContent = 'Visible only to trusted moderators, not other players. If you are in immediate danger, contact a trusted adult or local emergency services.'
      noteLabel.append(note, hint)
      form.append(noteLabel)

      const submit = document.createElement('button')
      submit.type = 'submit'
      submit.className = 'social-primary-btn rally-review-submit'
      submit.textContent = 'Submit review'
      form.append(submit)
      form.addEventListener('submit', submitReview)

      card.append(heading, game, form)
      targetsRoot.append(card)
    }
  }

  async function loadTargets() {
    if (!supabase) {
      setStatus('RALLY connection is unavailable. Refresh and try again.', true)
      targetsRoot.replaceChildren()
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'social-primary-btn'
      retry.textContent = 'Try again'
      retry.addEventListener('click', loadTargets)
      targetsRoot.append(retry)
      return
    }
    setStatus('')
    targetsRoot.replaceChildren()
    const loading = document.createElement('div')
    loading.className = 'rally-review-empty'
    loading.textContent = 'Loading eligible players…'
    targetsRoot.append(loading)

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError
      if (!sessionData.session) {
        showSignIn()
        return
      }
      const { data, error } = await supabase.rpc('get_rally_review_targets')
      if (error) throw error
      if (!Array.isArray(data)) throw new Error('RALLY returned an invalid review list.')
      renderTargets(data)
      loaded = true
    } catch (error) {
      console.error('RALLY review targets could not load:', error)
      setStatus(error.message || 'Could not load eligible players. Please try again.', true)
      targetsRoot.replaceChildren()
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'social-primary-btn'
      retry.textContent = 'Try again'
      retry.addEventListener('click', loadTargets)
      targetsRoot.append(retry)
    }
  }

  async function submitReview(event) {
    event.preventDefault()
    const form = event.currentTarget
    const submit = form.querySelector('button[type="submit"]')
    const fields = new FormData(form)
    submit.disabled = true
    submit.textContent = 'Submitting…'
    setStatus('')

    try {
      const { data, error } = await supabase.rpc('submit_rally_player_review', {
        p_game_id: form.dataset.gameId,
        p_reviewed_player_id: form.dataset.playerId,
        p_skill_rating: Number(fields.get('skill')),
        p_attitude_rating: Number(fields.get('attitude')),
        p_sportsmanship_rating: Number(fields.get('sportsmanship')),
        p_reliability_rating: Number(fields.get('reliability')),
        p_felt_safe: fields.get(`felt-safe-${form.dataset.playerId}`) === 'true',
        p_private_safety_note: String(fields.get('privateSafetyNote') || '').trim() || null,
      })
      if (error) throw error
      if (!data) throw new Error('RALLY did not confirm that the review was saved.')

      loaded = false
      await loadTargets()
      if (loaded) {
        setStatus('Review submitted. Thanks for helping make RALLY a better place to play.')
      } else {
        setStatus('Review submitted, but the list could not refresh. Reopen Player reviews to check for other eligible players.', true)
      }
    } catch (error) {
      console.error('RALLY player review could not be submitted:', error)
      setStatus(error.message || 'Could not submit your review. Please try again.', true)
      submit.disabled = false
      submit.textContent = 'Submit review'
    }
  }

  document.querySelectorAll('[data-social-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const isReviewsTab = tab.dataset.socialTab === 'reviews'
      reviewsPanel.classList.toggle('active', isReviewsTab)
      if (isReviewsTab) {
        loaded = false
        loadTargets()
      }
    })
  })

  async function connect() {
    for (let attempt = 0; attempt < 60 && !window.rallySupabase; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    supabase = window.rallySupabase
    if (!supabase) {
      setStatus('RALLY connection is unavailable. Refresh and try again.', true)
      return
    }
    const { data, error } = supabase.auth.onAuthStateChange(() => {
      setTimeout(() => {
        loaded = false
        if (reviewsPanel.classList.contains('active')) loadTargets()
      }, 0)
    })
    if (error) throw error
    authSubscription = data.subscription
  }

  connect().catch((error) => {
    console.error('RALLY reviews could not connect:', error)
    setStatus(error.message || 'Could not connect to RALLY reviews.', true)
  })

  window.addEventListener('beforeunload', () => authSubscription?.unsubscribe(), { once: true })
}
