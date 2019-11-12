import '@testing-library/jest-dom/extend-expect'

expect.extend({
  toBeWithinRange(received, floor, ceiling) {
    const pass = received >= floor && received <= ceiling
    if (pass) {
      return {
        message: () =>
          `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      }
    } else {
      return {
        message: () =>
          `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      }
    }
  }
})

expect.extend({
  toHaveBeenCalledWithinRange(received, floor, ceiling) {
    const callcount = received.mock ? received.mock.calls.length : received.calls.count()
    const pass = callcount >= floor && callcount <= ceiling
    return {
      message: () => `got called ${callcount} times, not in range ${floor} - ${ceiling}`,
      pass
    }
  }
})

