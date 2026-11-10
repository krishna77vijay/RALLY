import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getAgeOnDate,
  getLegacyAgeGroup,
  isPlayerEligibleForGame,
} from './rally-age.js'

const today = new Date('2026-11-10T12:00:00.000Z')

test('age calculation handles birthdays and invalid dates', () => {
  assert.equal(getAgeOnDate('2012-11-10', today), 14)
  assert.equal(getAgeOnDate('2012-11-11', today), 13)
  assert.equal(getAgeOnDate('2027-01-01', today), null)
  assert.equal(getAgeOnDate('2012-02-30', today), null)
  assert.equal(getAgeOnDate('2008-02-29', new Date('2026-02-28T12:00:00.000Z')), 17)
  assert.equal(getAgeOnDate('2008-02-29', new Date('2026-03-01T12:00:00.000Z')), 18)
})

test('legacy display bands are derived without being used for eligibility', () => {
  assert.equal(getLegacyAgeGroup(14), '13–15')
  assert.equal(getLegacyAgeGroup(15), '13–15')
  assert.equal(getLegacyAgeGroup(16), '15–17')
  assert.equal(getLegacyAgeGroup(18), '17–19')
  assert.equal(getLegacyAgeGroup(20), null)
})

test('inclusive numeric game ranges accept the specified ages', () => {
  for (const [age, minAge, maxAge] of [
    [14, 13, 18],
    [15, 13, 15],
    [17, 15, 17],
    [18, 13, 18],
    [19, 17, 19],
  ]) {
    assert.equal(
      isPlayerEligibleForGame({
        age,
        minAge,
        maxAge,
        playerGender: 'girl',
        genderEligibility: 'all',
      }),
      true,
    )
  }
})

test('age, gender, null-profile, range, and admin rules are enforced', () => {
  const eligible = {
    age: 19,
    minAge: 13,
    maxAge: 18,
    playerGender: 'boy',
    genderEligibility: 'all',
  }

  assert.equal(isPlayerEligibleForGame(eligible), false)
  assert.equal(
    isPlayerEligibleForGame({ ...eligible, age: 14, genderEligibility: 'girl' }),
    false,
  )
  assert.equal(
    isPlayerEligibleForGame({
      ...eligible,
      age: 14,
      playerGender: 'girl',
      genderEligibility: 'girl',
    }),
    true,
  )
  assert.equal(
    isPlayerEligibleForGame({
      ...eligible,
      age: 14,
      playerGender: 'prefer_not_to_say',
      genderEligibility: 'all',
    }),
    true,
  )
  assert.equal(
    isPlayerEligibleForGame({
      ...eligible,
      age: 14,
      playerGender: 'prefer_not_to_say',
      genderEligibility: 'girl',
    }),
    false,
  )
  assert.equal(
    isPlayerEligibleForGame({ ...eligible, age: 14, playerGender: null }),
    false,
  )
  assert.equal(isPlayerEligibleForGame({ ...eligible, age: null }), false)
  assert.equal(
    isPlayerEligibleForGame({ ...eligible, age: 14, minAge: null }),
    false,
  )
  assert.equal(
    isPlayerEligibleForGame({ ...eligible, age: 14, minAge: 18, maxAge: 17 }),
    false,
  )
  assert.equal(
    isPlayerEligibleForGame({ ...eligible, age: null, isAdmin: true }),
    true,
  )
})
