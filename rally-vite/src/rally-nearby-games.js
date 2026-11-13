import {
  isValidCoordinates,
  sortNearbyGames,
} from './rally-nearby-utils.js'

const GEOAPIFY_API_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY?.trim() || ''
const VERIFIED_VENUES = new Map()
const pendingNearbyJoinIds = new Map()
const RADIUS_OPTIONS = [5, 10, 25]
const eventProperties = new Set([
  'method',
  'radiusKm',
  'resultCount',
  'durationMs',
  'success',
  'failureReason',
  'joinMode',
])

function normalizeVenue(venue) {
  return venue.trim().replace(/\s+/g, ' ').toLowerCase()
}

let selectedOrigin = null
let selectedLocationLabel = ''
let selectedMethod = null
let activeNearbyResults = null
let activeRadiusKm = null
let nearbyControls = null
let venueControls = null
let searchInProgress = false

function trackEvent(event, properties = {}) {
  const safeProperties = Object.fromEntries(
    Object.entries(properties).filter(
      ([key, value]) => eventProperties.has(key) && value !== undefined,
    ),
  )
  const detail = { event, properties: safeProperties }
  console.info('[RALLY event]', detail)
  window.dispatchEvent(new CustomEvent('rally:analytics', { detail }))
}

function getGeoapifyError(status) {
  if (status === 401 || status === 403) {
    return 'Geoapify rejected this request. Check the API key and its allowed origins.'
  }
  if (status === 429) return 'Location search is temporarily limited. Please try again shortly.'
  return 'Location search is unavailable right now. Please try again.'
}

async function geocodeLocation(query) {
  if (!GEOAPIFY_API_KEY) {
    throw new Error('Location search is not configured. Add VITE_GEOAPIFY_API_KEY and reload RALLY.')
  }
  if (typeof query !== 'string' || query.trim().length < 3) {
    throw new Error('Enter at least three characters for a city, area, or public venue.')
  }

  const url = new URL('https://api.geoapify.com/v1/geocode/search')
  url.searchParams.set('text', query.trim())
  url.searchParams.set('limit', '5')
  url.searchParams.set('lang', 'en')
  url.searchParams.set('apiKey', GEOAPIFY_API_KEY)

  let response
  try {
    response = await fetch(url)
  } catch {
    throw new Error('Could not reach Geoapify. Check your connection and try again.')
  }
  if (!response.ok) throw new Error(getGeoapifyError(response.status))

  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('Geoapify returned an unreadable location response.')
  }

  return (Array.isArray(payload.features) ? payload.features : [])
    .map((feature) => {
      const properties = feature?.properties
      return {
        label: typeof properties?.formatted === 'string' ? properties.formatted : '',
        latitude: Number(properties?.lat),
        longitude: Number(properties?.lon),
      }
    })
    .filter(
      (location) =>
        location.label && isValidCoordinates(location.latitude, location.longitude),
    )
}

async function waitForSupabase() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (window.rallySupabase) return window.rallySupabase
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('RALLY connection is unavailable. Refresh and try again.')
}

function setNearbyStatus(message, state = 'info') {
  if (!nearbyControls) return
  nearbyControls.status.textContent = message
  nearbyControls.status.dataset.state = state
}

function setSelectedLocation(label) {
  if (!nearbyControls) return
  nearbyControls.selected.textContent = label
  nearbyControls.selected.hidden = !label
  nearbyControls.clear.hidden = !label
}

function setLocationRequestBusy(busy) {
  if (!nearbyControls) return
  nearbyControls.gps.disabled = busy
  nearbyControls.manualSearch.disabled = busy
  nearbyControls.radius.disabled = busy
  nearbyControls.confirm.disabled = busy || !nearbyControls.choices.value
}

function showLocationChoices(select, locations) {
  select.replaceChildren()
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Choose a matching public area'
  select.append(placeholder)

  locations.forEach((location, index) => {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = location.label
    select.append(option)
  })
  select.hidden = locations.length === 0
}

function showVenueCandidates(select, locations) {
  showLocationChoices(select, locations)
  select.options[0].textContent = 'Choose the correct public venue'
}

function safeFailureReason(error) {
  if (error?.code === 'PGRST202' || error?.code === '42883') return 'migration_required'
  if (error?.message?.includes('Sign in')) return 'authentication_required'
  return 'search_failed'
}

async function searchNearbyGames(
  method,
  origin = selectedOrigin,
  locationLabel = selectedLocationLabel,
) {
  if (!origin || searchInProgress) return
  const radiusKm = Number(nearbyControls.radius.value)
  if (!RADIUS_OPTIONS.includes(radiusKm)) return

  searchInProgress = true
  nearbyControls.gps.disabled = true
  nearbyControls.manualSearch.disabled = true
  nearbyControls.confirm.disabled = true
  nearbyControls.radius.disabled = true
  const startedAt = performance.now()
  trackEvent('nearby_games_search_started', { method, radiusKm })
  setNearbyStatus('Searching eligible games near this area…', 'loading')

  try {
    const supabase = await waitForSupabase()
    const { data, error } = await supabase.rpc('find_rally_games_nearby', {
      p_latitude: origin.latitude,
      p_longitude: origin.longitude,
      p_radius_km: radiusKm,
    })
    if (error) throw error

    const results = sortNearbyGames(data, origin, radiusKm)
    activeNearbyResults = new Map(results.map((result) => [result.id, result.distanceKm]))
    activeRadiusKm = radiusKm
    selectedOrigin = origin
    selectedLocationLabel = locationLabel
    selectedMethod = method
    setSelectedLocation(locationLabel)
    nearbyControls.radius.value = String(radiusKm)
    const durationMs = Math.round(performance.now() - startedAt)
    trackEvent('nearby_games_loaded', {
      method,
      radiusKm,
      resultCount: results.length,
      durationMs,
      success: true,
    })
    if (results.length === 0) {
      trackEvent('nearby_games_empty', { method, radiusKm, resultCount: 0 })
      setNearbyStatus(
        'No eligible games were found in this radius. Try a wider search or another public area.',
        'empty',
      )
    } else {
      trackEvent('location_search_failed', {
        method: 'gps',
        success: false,
        failureReason: 'location_error',
      })
      setNearbyStatus(
        `${results.length} nearby ${results.length === 1 ? 'game' : 'games'} found. Approximate distances are shown on the cards.`,
        'success',
      )
    }

    window.dispatchEvent(
      new CustomEvent('rally:nearby-results', {
        detail: { active: true, radiusKm },
      }),
    )
  } catch (error) {
    console.error('RALLY nearby game search failed.', error?.code || 'unknown')
    const durationMs = Math.round(performance.now() - startedAt)
    const failureReason = safeFailureReason(error)
    trackEvent('nearby_games_loaded', {
      method,
      radiusKm,
      resultCount: 0,
      durationMs,
      success: false,
      failureReason,
    })
    setNearbyStatus(
      failureReason === 'migration_required'
        ? 'Nearby search needs the Supabase nearby-games migration. Apply it, then retry.'
        : error?.message || 'Nearby games could not be loaded. Please try again.',
      'error',
    )
    if (activeRadiusKm !== null) nearbyControls.radius.value = String(activeRadiusKm)
  } finally {
    searchInProgress = false
    nearbyControls.gps.disabled = false
    nearbyControls.manualSearch.disabled = false
    nearbyControls.confirm.disabled = !nearbyControls.choices.value
    nearbyControls.radius.disabled = false
  }
}

function setupNearbyControls() {
  const filters = document.getElementById('gameFilters')
  if (!filters) return

  const section = document.createElement('section')
  section.className = 'nearby-control'
  section.setAttribute('aria-labelledby', 'nearby-title')
  section.innerHTML = `
    <h3 id="nearby-title">FIND GAMES NEAR YOU</h3>
    <p class="nearby-copy">Use your location to find eligible games within this radius. It is used only for this search and is never saved or shown to other players. Or search a public area; its text is sent to Geoapify to find matching locations.</p>
    <button class="primary nearby-gps" type="button">Find games near me</button>
    <div class="nearby-selected" role="status" hidden></div>
    <label class="nearby-label" for="nearby-radius">DISTANCE</label>
    <select class="nearby-radius" id="nearby-radius">
      <option value="5">Within 5 km</option>
      <option value="10" selected>Within 10 km</option>
      <option value="25">Within 25 km</option>
    </select>
    <div class="nearby-manual">
      <label class="nearby-label" for="nearby-query">OR SEARCH A PUBLIC AREA</label>
      <div class="nearby-manual-row">
        <input class="nearby-query" id="nearby-query" type="search" maxlength="160" autocomplete="off" placeholder="City, area, or public venue">
        <button class="secondary nearby-manual-search" type="button">Search</button>
      </div>
      <select class="nearby-choices" aria-label="Select a public area" hidden></select>
      <button class="secondary nearby-confirm" type="button" disabled>Confirm location and search</button>
    </div>
    <button class="secondary nearby-clear" type="button" hidden>Clear nearby search</button>
    <p class="nearby-safety">For safety, choose a public or supervised sports venue.</p>
    <div class="nearby-status" role="status" aria-live="polite"></div>
  `
  const filterGrid = filters.querySelector('.filtersgrid')
  filters.insertBefore(section, filterGrid)
  nearbyControls = {
    root: section,
    gps: section.querySelector('.nearby-gps'),
    radius: section.querySelector('.nearby-radius'),
    query: section.querySelector('.nearby-query'),
    manualSearch: section.querySelector('.nearby-manual-search'),
    choices: section.querySelector('.nearby-choices'),
    confirm: section.querySelector('.nearby-confirm'),
    selected: section.querySelector('.nearby-selected'),
    clear: section.querySelector('.nearby-clear'),
    status: section.querySelector('.nearby-status'),
  }

  nearbyControls.gps.addEventListener('click', () => {
    trackEvent('location_search_started', { method: 'gps' })
    if (!navigator.geolocation) {
      trackEvent('location_search_failed', {
        method: 'gps',
        success: false,
        failureReason: 'unsupported',
      })
      setNearbyStatus(
        'This browser does not support location access. Search for a public area below instead.',
        'error',
      )
      return
    }

    trackEvent('location_permission_requested', { method: 'gps' })
    setNearbyStatus('Waiting for your location permission…', 'loading')
    setLocationRequestBusy(true)
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const latitude = position.coords.latitude
        const longitude = position.coords.longitude
        if (!isValidCoordinates(latitude, longitude)) {
          trackEvent('location_search_failed', {
            method: 'gps',
            success: false,
            failureReason: 'invalid_location',
          })
          setNearbyStatus(
            'Your browser returned an invalid location. Search for a public area instead.',
            'error',
          )
          setLocationRequestBusy(false)
          return
        }
        trackEvent('location_permission_granted', { method: 'gps', success: true })
        await searchNearbyGames(
          'gps',
          { latitude, longitude },
          'Your current area',
        )
      },
      (error) => {
        setLocationRequestBusy(false)
        if (error.code === error.PERMISSION_DENIED) {
          trackEvent('location_permission_denied', {
            method: 'gps',
            success: false,
            failureReason: 'denied',
          })
          trackEvent('location_search_failed', {
            method: 'gps',
            success: false,
            failureReason: 'denied',
          })
          setNearbyStatus(
            'Location permission was denied or blocked. You can still search manually below.',
            'error',
          )
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          trackEvent('location_search_failed', {
            method: 'gps',
            success: false,
            failureReason: 'unavailable',
          })
          setNearbyStatus(
            'Your location is unavailable right now. Search for a public area below instead.',
            'error',
          )
        } else if (error.code === error.TIMEOUT) {
          trackEvent('location_search_failed', {
            method: 'gps',
            success: false,
            failureReason: 'timeout',
          })
          setNearbyStatus(
            'Location lookup timed out. Try again or search for a public area below.',
            'error',
          )
        } else {
          setNearbyStatus(
            'Could not get your location. Search for a public area below instead.',
            'error',
          )
        }
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
    )
  })

  nearbyControls.manualSearch.addEventListener('click', async () => {
    trackEvent('location_search_started', { method: 'manual' })
    nearbyControls.manualSearch.disabled = true
    nearbyControls.manualLocations = []
    nearbyControls.choices.replaceChildren()
    nearbyControls.choices.hidden = true
    nearbyControls.confirm.disabled = true
    setNearbyStatus('Looking up public areas…', 'loading')
    try {
      const query = nearbyControls.query.value.trim()
      const locations = await geocodeLocation(query)
      if (nearbyControls.query.value.trim() !== query) {
        setNearbyStatus('The search text changed. Search again to choose a matching area.', 'error')
        return
      }
      if (locations.length === 0) {
        showLocationChoices(nearbyControls.choices, [])
        nearbyControls.confirm.disabled = true
        setNearbyStatus('No matching area found. Check the spelling and try again.', 'error')
        return
      }
      nearbyControls.manualLocations = locations
      showLocationChoices(nearbyControls.choices, locations)
      nearbyControls.confirm.disabled = true
      setNearbyStatus('Choose the matching public area, then confirm it to search.', 'success')
    } catch (error) {
      trackEvent('location_search_failed', {
        method: 'manual',
        success: false,
        failureReason: 'geocoding',
      })
      setNearbyStatus(error.message, 'error')
    } finally {
      nearbyControls.manualSearch.disabled = false
    }
  })

  nearbyControls.choices.addEventListener('change', () => {
    nearbyControls.confirm.disabled =
      !nearbyControls.choices.value || searchInProgress
  })
  nearbyControls.query.addEventListener('input', () => {
    nearbyControls.manualLocations = []
    nearbyControls.choices.replaceChildren()
    nearbyControls.choices.hidden = true
    nearbyControls.confirm.disabled = true
  })

  nearbyControls.confirm.addEventListener('click', async () => {
    const location = nearbyControls.manualLocations?.[Number(nearbyControls.choices.value)]
    if (!location || !isValidCoordinates(location.latitude, location.longitude)) return
    trackEvent('manual_location_selected', { method: 'manual' })
    await searchNearbyGames(
      'manual',
      { latitude: location.latitude, longitude: location.longitude },
      location.label,
    )
  })

  nearbyControls.radius.addEventListener('change', () => {
    if (selectedOrigin && activeNearbyResults) {
      searchNearbyGames(selectedMethod || 'manual')
    }
  })

  nearbyControls.clear.addEventListener('click', () => {
    selectedOrigin = null
    selectedLocationLabel = ''
    selectedMethod = null
    activeNearbyResults = null
    activeRadiusKm = null
    setSelectedLocation('')
    nearbyControls.choices.hidden = true
    nearbyControls.query.value = ''
    trackEvent('location_search_failed', {
      method: 'gps',
      success: false,
      failureReason: 'location_error',
    })
    setNearbyStatus('Nearby search cleared.', 'success')
    window.dispatchEvent(
      new CustomEvent('rally:nearby-results', { detail: { active: false } }),
    )
  })
}

function setupVenueVerification() {
  const venueInput = document.getElementById('newVenue')
  if (!venueInput) return

  const control = document.createElement('div')
  control.className = 'venue-geocode-control'
  control.innerHTML = `
    <button class="secondary venue-geocode-button" type="button">Verify public venue</button>
    <select class="venue-geocode-choices" aria-label="Choose the matching venue" hidden></select>
    <button class="secondary venue-geocode-confirm" type="button" disabled>Confirm venue</button>
    <p class="venue-geocode-status" role="status" aria-live="polite"></p>
  `
  venueInput.closest('.field')?.insertAdjacentElement('afterend', control)
  venueControls = {
    input: venueInput,
    root: control,
    verify: control.querySelector('.venue-geocode-button'),
    choices: control.querySelector('.venue-geocode-choices'),
    confirm: control.querySelector('.venue-geocode-confirm'),
    status: control.querySelector('.venue-geocode-status'),
  }

  venueInput.addEventListener('input', () => {
    VERIFIED_VENUES.delete(normalizeVenue(venueInput.value))
    venueControls.confirm.disabled = true
    venueControls.choices.hidden = true
    venueControls.status.textContent = 'Address changed. Verify it again before publishing.'
  })
  venueControls.verify.addEventListener('click', async () => {
    const venue = venueInput.value.trim()
    const confirmedVenue = VERIFIED_VENUES.get(normalizeVenue(venue))
    if (confirmedVenue) {
      venueControls.status.textContent =
        'This unchanged venue is already verified. Edit the address to choose a different result.'
      return
    }
    venueControls.verify.disabled = true
    venueControls.locations = []
    venueControls.choices.replaceChildren()
    venueControls.choices.hidden = true
    venueControls.confirm.disabled = true
    venueControls.status.textContent = 'Checking this public venue…'
    try {
      const locations = await geocodeLocation(venue)
      if (normalizeVenue(venueInput.value) !== normalizeVenue(venue)) {
        venueControls.status.textContent =
          'The venue address changed. Verify the updated address before confirming.'
        return
      }
      venueControls.locations = locations
      showVenueCandidates(venueControls.choices, locations)
      venueControls.confirm.disabled = true
      venueControls.status.textContent = locations.length
        ? 'Select the correct result, then confirm the venue.'
        : 'No matching venue found. Correct the address and retry.'
    } catch (error) {
      venueControls.status.textContent = error.message
    } finally {
      venueControls.verify.disabled = false
    }
  })
  venueControls.choices.addEventListener('change', () => {
    venueControls.confirm.disabled = !venueControls.choices.value
  })
  venueControls.confirm.addEventListener('click', () => {
    const location = venueControls.locations?.[Number(venueControls.choices.value)]
    if (!location || !isValidCoordinates(location.latitude, location.longitude)) return
    VERIFIED_VENUES.set(normalizeVenue(venueInput.value), {
      latitude: location.latitude,
      longitude: location.longitude,
    })
    venueControls.status.textContent = `Confirmed: ${location.label}`
    venueControls.choices.hidden = true
  })
}

function decorateNearbyCards(cardsRoot) {
  if (!activeNearbyResults || !cardsRoot) return
  const cards = [...cardsRoot.querySelectorAll('[data-card-id]')]
  const matches = cards
    .filter((card) => activeNearbyResults.has(String(card.dataset.cardId)))
    .sort(
      (left, right) =>
        activeNearbyResults.get(String(left.dataset.cardId)) -
        activeNearbyResults.get(String(right.dataset.cardId)),
    )

  for (const card of cards) {
    const distance = activeNearbyResults.get(String(card.dataset.cardId))
    card.hidden = !Number.isFinite(distance)
    if (!Number.isFinite(distance)) continue
    const details = card.querySelector('.details')
    if (!details) continue
    let distanceLabel = details.querySelector('.nearby-distance')
    if (!distanceLabel) {
      distanceLabel = document.createElement('span')
      distanceLabel.className = 'nearby-distance'
      details.append(distanceLabel)
    }
    distanceLabel.textContent =
      distance < 0.05 ? '<0.1 km away' : `${distance.toFixed(1)} km away`
  }

  const currentOrder = [...cardsRoot.querySelectorAll('[data-card-id]')].filter(
    (card) => !card.hidden,
  )
  if (
    currentOrder.length !== matches.length ||
    currentOrder.some((card, index) => card !== matches[index])
  ) {
    for (const card of matches) cardsRoot.append(card)
  }

  let empty = cardsRoot.querySelector('.nearby-empty')
  if (matches.length === 0) {
    cardsRoot.querySelector('.empty')?.remove()
    if (!empty) {
      empty = document.createElement('div')
      empty.className = 'empty nearby-empty'
      empty.innerHTML =
        '<strong>No nearby eligible games found.</strong><p>Try a wider radius, adjust your other filters, or choose another public area.</p>'
      cardsRoot.append(empty)
    }
  } else {
    empty?.remove()
  }

  if (nearbyControls) {
    nearbyControls.count = matches.length
  }
  const count = document.getElementById('count')
  if (count && activeRadiusKm !== null) {
    count.textContent = `${matches.length} ${matches.length === 1 ? 'game' : 'games'} within ${activeRadiusKm} km`
  }
}

function setupNearbyCardObserver() {
  const cardsRoot = document.getElementById('cards')
  if (!cardsRoot) return
  const observer = new MutationObserver(() => decorateNearbyCards(cardsRoot))
  observer.observe(cardsRoot, { childList: true, subtree: true })
  cardsRoot.addEventListener('click', (event) => {
    const viewButton = event.target.closest('[data-view-id]')
    if (!viewButton && event.target.closest('button')) return
    const card = viewButton || event.target.closest('[data-card-id]')
    if (!card || !activeNearbyResults?.has(String(card.dataset.cardId || card.dataset.viewId))) {
      return
    }
    const gameId = String(card.dataset.cardId || card.dataset.viewId)
    trackEvent('nearby_game_opened', {
      method: selectedMethod || 'manual',
      radiusKm: activeRadiusKm,
    })
    card.dataset.nearbyTracked = gameId
  })
  cardsRoot.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const card = event.target.closest('[data-card-id]')
    if (card && activeNearbyResults?.has(String(card.dataset.cardId))) {
      trackEvent('nearby_game_opened', {
        method: selectedMethod || 'manual',
        radiusKm: activeRadiusKm,
      })
    }
  })
}

function setupStyles() {
  const style = document.createElement('style')
  style.textContent = `
    .nearby-control{margin:18px 0;padding:16px;border:1px solid #234365;border-radius:14px;background:#0b2342}
    .nearby-control h3{margin:0 0 7px;color:#f3f8ff;font-size:12px;font-weight:900;letter-spacing:1px}
    .nearby-copy,.nearby-safety{margin:0;color:#a9bed6;font-size:11px;line-height:1.6}
    .nearby-gps,.nearby-confirm,.nearby-clear{width:100%;margin-top:12px}
    .nearby-label{display:block;margin:13px 0 6px;color:#b8cde2;font-size:10px;font-weight:900;letter-spacing:.6px}
    .nearby-radius,.nearby-query,.nearby-choices{width:100%;min-height:42px;padding:9px 10px;border:1px solid #31516f;border-radius:9px;color:#f3f8ff;background:#071a35}
    .nearby-manual{margin-top:5px;padding-top:12px;border-top:1px solid #234365}
    .nearby-manual-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px}
    .nearby-manual-search{padding:9px 12px}
    .nearby-confirm{margin-top:8px}
    .nearby-selected{margin-top:11px;padding:9px 10px;border-radius:8px;color:#a9f0ff;background:#123c5d;font-size:11px;overflow-wrap:anywhere}
    .nearby-status{margin-top:10px;color:#b8cde2;font-size:11px;line-height:1.55}
    .nearby-status[data-state="error"]{color:#ffd166}
    .nearby-status[data-state="success"]{color:#a9f0ff}
    .nearby-status[data-state="loading"]{color:#d8d0ff}
    .nearby-safety{margin-top:11px;color:#ffd166}
    .venue-geocode-control{grid-column:1/-1;margin:-4px 0 12px;padding:11px;border:1px solid #234365;border-radius:10px;background:#0b2342}
    .venue-geocode-control button{margin:0 6px 6px 0}
    .venue-geocode-control select{width:100%;min-height:42px;margin:5px 0 8px;padding:9px;border:1px solid #31516f;border-radius:8px;color:#f3f8ff;background:#071a35}
    .venue-geocode-status{margin:4px 0 0;color:#a9bed6;font-size:11px;line-height:1.5}
    .nearby-distance{color:#ffd166;font-weight:900}
    .game[hidden]{display:none!important}
    @media(max-width:560px){.nearby-control{padding:13px}.nearby-manual-row{grid-template-columns:1fr}.nearby-manual-search{width:100%}.venue-geocode-control button{width:100%;margin-right:0}}
  `
  document.head.append(style)
}

function setupNearbyEventBridge() {
  window.addEventListener('rally:nearby-results', (event) => {
    if (!event.detail?.active) {
      activeNearbyResults = null
      activeRadiusKm = null
    } else {
      activeRadiusKm = Number(event.detail.radiusKm)
    }
    window.dispatchEvent(new Event('rally:request-render'))
  })
}

setupStyles()
setupNearbyControls()
setupVenueVerification()
setupNearbyCardObserver()
setupNearbyEventBridge()

window.rallyTrackEvent = trackEvent
window.rallyNearbyGames = {
  getVerifiedVenueCoordinates(venue) {
    if (typeof venue !== 'string') return null
    return VERIFIED_VENUES.get(normalizeVenue(venue)) || null
  },
  trackJoinClicked(game) {
    if (!game || !activeNearbyResults?.has(String(game.id))) return
    trackEvent('nearby_game_join_clicked', {
      method: selectedMethod || 'manual',
      radiusKm: activeRadiusKm,
      joinMode: game.joinMode === 'approval' ? 'approval' : 'open',
    })
  },
  trackJoinPending(game) {
    if (!game || !activeNearbyResults?.has(String(game.id))) return
    const properties = {
      method: selectedMethod || 'manual',
      radiusKm: activeRadiusKm,
      joinMode: 'approval',
      success: true,
    }
    pendingNearbyJoinIds.set(String(game.id), {
      method: properties.method,
      radiusKm: properties.radiusKm,
    })
    trackEvent('nearby_game_join_pending', properties)
  },
  trackJoinSuccess(game) {
    if (!game || !activeNearbyResults?.has(String(game.id))) return
    trackEvent('nearby_game_join_success', {
      method: selectedMethod || 'manual',
      radiusKm: activeRadiusKm,
      joinMode: 'open',
      success: true,
    })
  },
  trackJoinedGames(gameIds) {
    for (const gameId of gameIds) {
      const key = String(gameId)
      const pendingSearch = pendingNearbyJoinIds.get(key)
      if (!pendingSearch) continue
      pendingNearbyJoinIds.delete(key)
      trackEvent('nearby_game_join_success', {
        ...pendingSearch,
        joinMode: 'approval',
        success: true,
      })
    }
  },
}
