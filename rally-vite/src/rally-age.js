const MIN_SUPPORTED_AGE = 13
const MAX_SUPPORTED_AGE = 19
const ALLOWED_GENDERS = new Set(['girl', 'boy', 'prefer_not_to_say'])

export function getAgeOnDate(birthDate, today = new Date()) {
  if (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    return null
  }

  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number)
  const parsedBirthDate = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay))
  if (
    parsedBirthDate.getUTCFullYear() !== birthYear ||
    parsedBirthDate.getUTCMonth() !== birthMonth - 1 ||
    parsedBirthDate.getUTCDate() !== birthDay
  ) {
    return null
  }

  const age =
    today.getUTCFullYear() -
    birthYear -
    (today.getUTCMonth() < birthMonth - 1 ||
    (today.getUTCMonth() === birthMonth - 1 && today.getUTCDate() < birthDay)
      ? 1
      : 0)

  return age >= 0 ? age : null
}

export function isPlayerEligibleForGame({
  age,
  minAge,
  maxAge,
  playerGender,
  genderEligibility,
  isAdmin = false,
}) {
  if (isAdmin) return true
  if (
    !Number.isInteger(age) ||
    !Number.isInteger(minAge) ||
    !Number.isInteger(maxAge) ||
    minAge < MIN_SUPPORTED_AGE ||
    maxAge > MAX_SUPPORTED_AGE ||
    minAge > maxAge ||
    !ALLOWED_GENDERS.has(playerGender)
  ) {
    return false
  }

  return (
    age >= minAge &&
    age <= maxAge &&
    (genderEligibility === 'all' || genderEligibility === playerGender)
  )
}

export function getLegacyAgeGroup(age) {
  if (!Number.isInteger(age) || age < MIN_SUPPORTED_AGE || age > MAX_SUPPORTED_AGE) {
    return null
  }
  if (age <= 15) return '13–15'
  if (age <= 17) return '15–17'
  return '17–19'
}

if (typeof window !== 'undefined') {
  window.rallyAge = { getAgeOnDate, isPlayerEligibleForGame, getLegacyAgeGroup }
}
