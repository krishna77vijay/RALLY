const EARTH_RADIUS_KM = 6371
const MIN_GEOCODE_CONFIDENCE = 0.75
const MIN_GEOCODE_CONFIDENCE_GAP = 0.1

export function isValidCoordinates(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  )
}

export function selectConfidentGeocodeResult(locations) {
  if (!Array.isArray(locations) || locations.length === 0) return null

  const ranked = locations
    .filter(
      (location) =>
        location &&
        isValidCoordinates(location.latitude, location.longitude) &&
        Number.isFinite(location.confidence),
    )
    .sort((left, right) => right.confidence - left.confidence)

  const best = ranked[0]
  const second = ranked[1]
  if (!best || best.confidence < MIN_GEOCODE_CONFIDENCE) return null
  if (
    second &&
    best.confidence - second.confidence < MIN_GEOCODE_CONFIDENCE_GAP
  ) {
    return null
  }
  return best
}

export function haversineDistanceKm(from, to) {
  if (
    !isValidCoordinates(from?.latitude, from?.longitude) ||
    !isValidCoordinates(to?.latitude, to?.longitude)
  ) {
    return null
  }

  const toRadians = (degrees) => (degrees * Math.PI) / 180
  const latitudeDelta = toRadians(to.latitude - from.latitude)
  const longitudeDelta = toRadians(to.longitude - from.longitude)
  const fromLatitude = toRadians(from.latitude)
  const toLatitude = toRadians(to.latitude)
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, haversine)))
}

export function sortNearbyGames(rows, origin, radiusKm) {
  if (!Array.isArray(rows) || ![5, 10, 25].includes(radiusKm)) return []

  return rows
    .filter(
      (row) =>
        row &&
        (typeof row.game_id === 'string' || typeof row.game_id === 'number') &&
        row.latitude !== null &&
        row.longitude !== null &&
        row.latitude !== '' &&
        row.longitude !== '',
    )
    .map((row) => ({
      id: String(row.game_id),
      distanceKm: haversineDistanceKm(origin, {
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      }),
    }))
    .filter(
      (row) =>
        row.distanceKm !== null &&
        Number.isFinite(row.distanceKm) &&
        row.distanceKm <= radiusKm,
    )
    .sort((left, right) => left.distanceKm - right.distanceKm)
}
