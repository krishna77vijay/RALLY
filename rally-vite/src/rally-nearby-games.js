import {
  isValidCoordinates,
  selectConfidentGeocodeResult,
  sortNearbyGames,
} from './rally-nearby-utils.js'

const GEOAPIFY_API_KEY = import.meta.env.VITE_GEOAPIFY_API_KEY?.trim() || ''
const VERIFIED_VENUES = new Map()
const pendingNearbyJoinIds = new Map()
const RADIUS_OPTIONS = [5, 10, 25]
const LOCATION_PROMPT_DELAY_MS = 150_000
const SAVED_LOCATION_KEY = 'rally-nearby-location-v1'
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

function getSavedLocationKey(userId) {
  return `${SAVED_LOCATION_KEY}:${userId}`
}

function readSavedLocation(userId) {
  try {
    const saved = window.localStorage.getItem(getSavedLocationKey(userId))
    if (!saved) return null
    const location = JSON.parse(saved)
    if (
      location?.version !== 1 ||
      !isValidCoordinates(location.latitude, location.longitude) ||
      !RADIUS_OPTIONS.includes(location.radiusKm) ||
      !['gps', 'manual'].includes(location.method) ||
      typeof location.label !== 'string'
    ) {
      console.error('RALLY saved nearby location is invalid; ignoring the stored value.')
      return null
    }
    return location
  } catch (error) {
    console.error('RALLY could not read the saved nearby location.', error)
    return null
  }
}

function saveLocationOnDevice(userId, origin, label, method, radiusKm) {
  if (!userId || !isValidCoordinates(origin?.latitude, origin?.longitude)) return
  const savedLocation = {
    version: 1,
    latitude: Number(origin.latitude.toFixed(3)),
    longitude: Number(origin.longitude.toFixed(3)),
    label,
    method,
    radiusKm,
  }
  try {
    window.localStorage.setItem(
      getSavedLocationKey(userId),
      JSON.stringify(savedLocation),
    )
    updateSavedLocationNotice(savedLocation)
  } catch (error) {
    console.error('RALLY could not save the nearby location on this device.', error)
    setNearbyStatus(
      'Nearby games loaded, but this browser could not save the location for next time.',
      'error',
    )
  }
}

function updateSavedLocationNotice(location) {
  if (!nearbyControls) return
  nearbyControls.forget.hidden = !location
  nearbyControls.saved.textContent = location
    ? 'A rounded, approximate location is saved on this device for your next sign-in.'
    : ''
  nearbyControls.saved.hidden = !location
}

let selectedOrigin = null
let selectedLocationLabel = ''
let selectedMethod = null
let activeNearbyResults = null
let activeRadiusKm = null
let nearbyControls = null
let venueControls = null
let searchInProgress = false
let authenticatedUserId = null
let joinedGameState = null
let locationPromptTimer = null
let locationPromptDialog = null
let locationPromptShown = false

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
        confidence: Number(properties?.rank?.confidence),
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
    if (nearbyControls.remember.checked && authenticatedUserId) {
      saveLocationOnDevice(
        authenticatedUserId,
        origin,
        locationLabel,
        method,
        radiusKm,
      )
    }
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
    <p class="nearby-copy">Use your location to find eligible games within this radius. It is never shown to other players. If you choose to remember it, only a rounded approximate location is saved on this device. Or search a public area; its text is sent to Geoapify to find matching locations.</p>
    <button class="primary nearby-gps" type="button">Find games near me</button>
    <label class="nearby-remember"><input class="nearby-remember-checkbox" type="checkbox"><span>Remember this approximate location on this device for my next sign-in</span></label>
    <p class="nearby-saved" role="status" hidden></p>
    <button class="secondary nearby-forget" type="button" hidden>Forget saved location</button>
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
    remember: section.querySelector('.nearby-remember-checkbox'),
    saved: section.querySelector('.nearby-saved'),
    forget: section.querySelector('.nearby-forget'),
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
    setNearbyStatus('Nearby search cleared.', 'success')
    window.dispatchEvent(
      new CustomEvent('rally:nearby-results', { detail: { active: false } }),
    )
  })

  nearbyControls.forget.addEventListener('click', () => {
    if (!authenticatedUserId) return
    try {
      window.localStorage.removeItem(getSavedLocationKey(authenticatedUserId))
      updateSavedLocationNotice(null)
      nearbyControls.remember.checked = false
      setNearbyStatus('Saved location forgotten on this device.', 'success')
      cancelLocationPrompt()
      window.setTimeout(updateLocationPromptTimer, 0)
    } catch (error) {
      console.error('RALLY could not remove the saved nearby location.', error)
      setNearbyStatus('Could not forget the saved location in this browser.', 'error')
    }
  })
  nearbyControls.remember.addEventListener('change', () => {
    if (nearbyControls.remember.checked || !authenticatedUserId) return
    try {
      window.localStorage.removeItem(getSavedLocationKey(authenticatedUserId))
      updateSavedLocationNotice(null)
      setNearbyStatus('Saved location will be forgotten on this device.', 'success')
      cancelLocationPrompt()
      window.setTimeout(updateLocationPromptTimer, 0)
    } catch (error) {
      console.error('RALLY could not remove the saved nearby location.', error)
      setNearbyStatus('Could not forget the saved location in this browser.', 'error')
    }
  })
}

function setupVenueVerification() {
  const venueInput = document.getElementById('newVenue')
  if (!venueInput) return

  const control = document.createElement('div')
  control.className = 'venue-geocode-control'
  control.innerHTML = `
    <p>RALLY will check this venue with Geoapify when you publish. If it cannot confidently match it, you can choose the correct result below.</p>
    <button class="secondary venue-geocode-button" type="button">Check venue now</button>
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
    venueControls.status.textContent = 'Address changed. It will be checked when you publish.'
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

async function resolveVenueCoordinates(venue) {
  if (typeof venue !== 'string' || venue.trim().length < 3) {
    throw new Error('Enter a complete public venue address.')
  }
  const key = normalizeVenue(venue)
  const confirmedVenue = VERIFIED_VENUES.get(key)
  if (confirmedVenue) return confirmedVenue

  if (venueControls) {
    venueControls.status.textContent = 'Checking this venue with Geoapify…'
    venueControls.choices.hidden = true
    venueControls.confirm.disabled = true
  }

  try {
    const locations = await geocodeLocation(venue)
    if (venueControls && normalizeVenue(venueControls.input.value) !== key) {
      throw new Error('The venue changed while it was being checked. Publish again to verify the updated address.')
    }

    const match = selectConfidentGeocodeResult(locations)
    if (!match) {
      if (venueControls) {
        venueControls.locations = locations
        showVenueCandidates(venueControls.choices, locations)
        venueControls.status.textContent = locations.length
          ? 'Geoapify found multiple or uncertain matches. Choose the correct venue and confirm it, then publish again.'
          : 'Geoapify could not find this venue. Correct the address and retry.'
      }
      throw new Error(
        locations.length
          ? 'Geoapify could not confidently identify one venue. Choose the correct result, confirm it, and publish again.'
          : 'Geoapify could not find this venue. Correct the public venue address and try again.',
      )
    }

    const coordinates = {
      latitude: match.latitude,
      longitude: match.longitude,
    }
    VERIFIED_VENUES.set(key, coordinates)
    if (venueControls) {
      venueControls.status.textContent = `Venue confirmed: ${match.label}`
      venueControls.choices.hidden = true
    }
    return coordinates
  } catch (error) {
    if (venueControls) venueControls.status.textContent = error.message
    throw error
  }
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
    const formattedDistance =
      distance < 0.05 ? '<0.1 km away' : `${distance.toFixed(1)} km away`
    if (distanceLabel.textContent !== formattedDistance) {
      distanceLabel.textContent = formattedDistance
    }
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
    cardsRoot.querySelector('.empty:not(.nearby-empty)')?.remove()
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
}

function cancelLocationPrompt() {
  if (locationPromptTimer !== null) {
    window.clearTimeout(locationPromptTimer)
    locationPromptTimer = null
  }
  if (locationPromptDialog) locationPromptDialog.hidden = true
}

function isFindGameRouteActive() {
  return (
    document.body.classList.contains('rally-route-find') ||
    document.body.classList.contains('find-game-view')
  )
}

function ensureLocationPrompt() {
  if (locationPromptDialog || !nearbyControls) return

  const overlay = document.createElement('div')
  overlay.className = 'nearby-prompt-overlay'
  overlay.hidden = true
  overlay.innerHTML = `
    <section class="nearby-prompt" role="dialog" aria-modal="true" aria-labelledby="nearby-prompt-title">
      <div class="eyebrow">YOUR NEXT GAME</div>
      <h2 id="nearby-prompt-title">Find games near you</h2>
      <p>Choose to share your current location for this search, or find games by searching a public area. Location access is never requested unless you choose the button.</p>
      <button class="primary nearby-prompt-gps" type="button">Find games near me</button>
      <button class="secondary nearby-prompt-manual" type="button">Search a public area instead</button>
      <button class="nearby-prompt-dismiss" type="button">Not now</button>
    </section>
  `
  document.body.append(overlay)
  locationPromptDialog = overlay

  overlay.querySelector('.nearby-prompt-gps').addEventListener('click', () => {
    overlay.hidden = true
    if (!nearbyControls.root.closest('.layout')?.classList.contains('filters-open')) {
      document.getElementById('toggleFilters')?.click()
    }
    nearbyControls.root.scrollIntoView({ behavior: 'smooth', block: 'center' })
    nearbyControls.gps.click()
  })
  overlay.querySelector('.nearby-prompt-manual').addEventListener('click', () => {
    overlay.hidden = true
    if (!nearbyControls.root.closest('.layout')?.classList.contains('filters-open')) {
      document.getElementById('toggleFilters')?.click()
    }
    nearbyControls.query.focus({ preventScroll: true })
    nearbyControls.query.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  overlay.querySelector('.nearby-prompt-dismiss').addEventListener('click', () => {
    overlay.hidden = true
    trackEvent('nearby_location_prompt_dismissed', { success: true })
  })
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      overlay.hidden = true
      trackEvent('nearby_location_prompt_dismissed', { success: true })
    }
  })
}

function updateLocationPromptTimer() {
  if (
    !authenticatedUserId ||
    joinedGameState !== false ||
    readSavedLocation(authenticatedUserId) ||
    locationPromptShown ||
    !isFindGameRouteActive()
  ) {
    cancelLocationPrompt()
    return
  }
  if (locationPromptTimer !== null) return

  locationPromptTimer = window.setTimeout(() => {
    locationPromptTimer = null
    if (
      !authenticatedUserId ||
      joinedGameState !== false ||
      readSavedLocation(authenticatedUserId) ||
      !isFindGameRouteActive()
    ) {
      updateLocationPromptTimer()
      return
    }
    ensureLocationPrompt()
    locationPromptDialog.hidden = false
    locationPromptShown = true
    trackEvent('nearby_location_prompt_shown', { success: true })
  }, LOCATION_PROMPT_DELAY_MS)
}

async function updateAuthenticatedUser(userId) {
  if (userId === authenticatedUserId) return

  cancelLocationPrompt()
  authenticatedUserId = userId || null
  joinedGameState = null
  locationPromptShown = false
  selectedOrigin = null
  selectedLocationLabel = ''
  selectedMethod = null
  activeNearbyResults = null
  activeRadiusKm = null
  setSelectedLocation('')

  if (!authenticatedUserId) {
    updateSavedLocationNotice(null)
    nearbyControls.remember.checked = false
    window.dispatchEvent(
      new CustomEvent('rally:nearby-results', { detail: { active: false } }),
    )
    return
  }

  const savedLocation = readSavedLocation(authenticatedUserId)
  updateSavedLocationNotice(savedLocation)
  nearbyControls.remember.checked = Boolean(savedLocation)
  if (savedLocation) {
    nearbyControls.radius.value = String(savedLocation.radiusKm)
    await searchNearbyGames(
      savedLocation.method,
      {
        latitude: savedLocation.latitude,
        longitude: savedLocation.longitude,
      },
      savedLocation.label,
    )
  } else {
    updateLocationPromptTimer()
  }
}

function setupLocationPromptLifecycle() {
  const routeObserver = new MutationObserver(updateLocationPromptTimer)
  routeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  })

  window.addEventListener('rally:games-joined-state', (event) => {
    if (event.detail?.userId !== authenticatedUserId || !event.detail.loaded) return
    joinedGameState = event.detail.hasJoined === true
    if (joinedGameState) cancelLocationPrompt()
    else updateLocationPromptTimer()
  })
  window.addEventListener('rally:game-joined', () => {
    joinedGameState = true
    cancelLocationPrompt()
  })
  window.addEventListener('rally-profile-updated', () => {
    if (selectedOrigin && selectedMethod) {
      searchNearbyGames(selectedMethod).catch((error) => {
        console.error('RALLY nearby games could not refresh after the profile changed.', error)
      })
    }
  })

  waitForSupabase()
    .then(async (supabase) => {
      const { data, error } = await supabase.auth.getSession()
      if (error) throw error
      await updateAuthenticatedUser(data.session?.user?.id || null)
      supabase.auth.onAuthStateChange(
        (_event, session) => {
          window.setTimeout(() => {
            updateAuthenticatedUser(session?.user?.id || null).catch((error) => {
              console.error('RALLY could not restore its saved nearby location.', error)
            })
          }, 0)
        },
      )
    })
    .catch((error) => {
      console.error('RALLY could not initialize nearby location preferences.', error)
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
    .nearby-remember{display:flex;align-items:flex-start;gap:8px;margin-top:12px;color:#b8cde2;font-size:10px;line-height:1.5}
    .nearby-remember input{width:16px;height:16px;margin:0;accent-color:#08b9f0;flex:0 0 auto}
    .nearby-saved{margin:8px 0 0;color:#a9f0ff;font-size:10px;line-height:1.5}
    .nearby-forget{width:100%;margin-top:8px;padding:8px;font-size:10px}
    .nearby-prompt-overlay{position:fixed;inset:0;z-index:10001;display:grid;place-items:center;padding:18px;background:#020b18d9;backdrop-filter:blur(5px)}
    .nearby-prompt-overlay[hidden]{display:none}
    .nearby-prompt{width:min(440px,100%);padding:24px;border:1px solid #315879;border-radius:18px;background:#0b2342;box-shadow:0 25px 80px #0008}
    .nearby-prompt h2{margin:9px 0;color:#f3f8ff;font:800 30px 'Barlow Condensed',sans-serif}
    .nearby-prompt p{color:#b8cde2;font-size:12px;line-height:1.7}
    .nearby-prompt-gps,.nearby-prompt-manual{width:100%;margin-top:8px}
    .nearby-prompt-dismiss{display:block;margin:12px auto 0;padding:7px 12px;border:0;color:#a9bed6;background:transparent;font-size:11px}
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
setupLocationPromptLifecycle()

window.rallyTrackEvent = trackEvent
window.rallyNearbyGames = {
  resolveVenueCoordinates,
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
    window.dispatchEvent(new Event('rally:game-joined'))
    if (!game || !activeNearbyResults?.has(String(game.id))) return
    trackEvent('nearby_game_join_success', {
      method: selectedMethod || 'manual',
      radiusKm: activeRadiusKm,
      joinMode: 'open',
      success: true,
    })
  },
  trackJoinedGames(gameIds) {
    if (gameIds.length > 0) window.dispatchEvent(new Event('rally:game-joined'))
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
