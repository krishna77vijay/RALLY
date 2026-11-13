import test from 'node:test'
import assert from 'node:assert/strict'
import {
  haversineDistanceKm,
  isValidCoordinates,
  selectConfidentGeocodeResult,
  sortNearbyGames,
} from './rally-nearby-utils.js'

test('validates geographic coordinate bounds', () => {
  assert.equal(isValidCoordinates(0, 0), true)
  assert.equal(isValidCoordinates(90, 180), true)
  assert.equal(isValidCoordinates(91, 0), false)
  assert.equal(isValidCoordinates(0, -181), false)
  assert.equal(isValidCoordinates(Number.NaN, 0), false)
})

test('calculates Haversine distance for known locations and the antimeridian', () => {
  const london = { latitude: 51.5072, longitude: -0.1276 }
  const paris = { latitude: 48.8566, longitude: 2.3522 }
  const distance = haversineDistanceKm(london, paris)
  assert.ok(distance !== null && distance > 343 && distance < 345)

  const acrossDateline = haversineDistanceKm(
    { latitude: 0, longitude: 179.9 },
    { latitude: 0, longitude: -179.9 },
  )
  assert.ok(acrossDateline !== null && acrossDateline > 22 && acrossDateline < 23)
  assert.equal(haversineDistanceKm(london, { latitude: 91, longitude: 0 }), null)
})

test('nearby results exclude invalid and out-of-radius games and sort nearest first', () => {
  const origin = { latitude: 0, longitude: 0 }
  const results = sortNearbyGames(
    [
      { game_id: 'far', latitude: 0, longitude: 0.3 },
      { game_id: 'second', latitude: 0, longitude: 0.04 },
      { game_id: 'first', latitude: 0, longitude: 0.01 },
      { game_id: 'missing', latitude: null, longitude: null },
      { game_id: 'invalid', latitude: 91, longitude: 0 },
    ],
    origin,
    5,
  )

  assert.deepEqual(results.map((result) => result.id), ['first', 'second'])
  assert.ok(results[0].distanceKm < results[1].distanceKm)
  assert.deepEqual(sortNearbyGames([], origin, 7), [])
})

test('5 km, 10 km, and 25 km filters include only games in the chosen radius', () => {
  const origin = { latitude: 0, longitude: 0 }
  const games = [
    { game_id: 'near', latitude: 0, longitude: 0.04 },
    { game_id: 'medium', latitude: 0, longitude: 0.08 },
    { game_id: 'far', latitude: 0, longitude: 0.18 },
  ]

  assert.deepEqual(sortNearbyGames(games, origin, 5).map((game) => game.id), ['near'])
  assert.deepEqual(
    sortNearbyGames(games, origin, 10).map((game) => game.id),
    ['near', 'medium'],
  )
  assert.deepEqual(
    sortNearbyGames(games, origin, 25).map((game) => game.id),
    ['near', 'medium', 'far'],
  )
})

test('automatically selects only a confident, unambiguous Geoapify venue match', () => {
  const confirmed = { label: 'Public Sports Centre', latitude: 51, longitude: 0, confidence: 0.92 }
  assert.equal(
    selectConfidentGeocodeResult([confirmed, { ...confirmed, confidence: 0.7 }]),
    confirmed,
  )
  assert.equal(
    selectConfidentGeocodeResult([
      { ...confirmed, confidence: 0.91 },
      { ...confirmed, label: 'Another venue', confidence: 0.86 },
    ]),
    null,
  )
  assert.equal(
    selectConfidentGeocodeResult([{ ...confirmed, confidence: 0.74 }]),
    null,
  )
  assert.equal(selectConfidentGeocodeResult([]), null)
})
