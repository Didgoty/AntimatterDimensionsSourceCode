class BlackHoleUpgradeState {
  constructor(config) {
    const { getAmount, setAmount, calculateValue, initialCost, costMult } = config;
    this.incrementAmount = () => setAmount(getAmount() + 1);
    this._lazyValue = new Lazy(() => calculateValue(getAmount()));
    this._lazyCost = new Lazy(() => getCostWithLinearCostScaling(getAmount(), 1e30, initialCost, costMult, 0.2));
  }

  get value() {
    return this._lazyValue.value;
  }

  get cost() {
    return this._lazyCost.value;
  }

  get isAffordable() {
    return player.reality.realityMachines.gte(this.cost);
  }

  purchase() {
    if (!this.isAffordable) return;
    player.reality.realityMachines = player.reality.realityMachines.minus(this.cost);
    this.incrementAmount();
    EventHub.dispatch(GameEvent.BLACK_HOLE_UPGRADE_BOUGHT);
  }
}

class BlackHoleState {
  constructor(id) {
    this.id = id + 1;
    const wormholeCostMultipliers = [1, 1000, 1e35];
    // Interval: starts at 3600, x0.8 per upgrade, upgrade cost goes x3.5, starts at 15
    this.intervalUpgrade = new BlackHoleUpgradeState({
      getAmount: () => this._data.intervalUpgrades,
      setAmount: amount => this._data.intervalUpgrades = amount,
      calculateValue: amount => (3600 / (Math.pow(10, id))) * Math.pow(0.8, amount),
      initialCost: 15 * wormholeCostMultipliers[id],
      costMult: 3.5
    });
    // Power: starts at 5, x1.35 per upgrade, cost goes x2, starts at 20
    this.powerUpgrade = new BlackHoleUpgradeState({
      getAmount: () => this._data.powerUpgrades,
      setAmount: amount => this._data.powerUpgrades = amount,
      calculateValue: amount => (180 / Math.pow(2, id)) * Math.pow(1.35, amount),
      initialCost: 20 * wormholeCostMultipliers[id],
      costMult: 2
    });
    // Duration: starts at 10, x1.5 per upgrade, cost goes x4, starts at 10
    this.durationUpgrade = new BlackHoleUpgradeState({
      getAmount: () => this._data.durationUpgrades,
      setAmount: amount => this._data.durationUpgrades = amount,
      calculateValue: amount => (10 - (id) * 3) * Math.pow(1.3, amount),
      initialCost: 10 * wormholeCostMultipliers[id],
      costMult: 4
    });
  }

  /**
   * @private
   */
  get _data() {
    return player.blackHole[this.id - 1];
  }

  /**
   * Amount of time the black hole is inactive for between activations.
   */
  get interval() {
    return this.intervalUpgrade.value;
  }

  /**
   * Multiplier to time the black hole gives when active.
   */
  get power() {
    return this.powerUpgrade.value;
  }

  /**
   * Amount of time the black hole is active for.
   */
  get duration() {
    return this.durationUpgrade.value;
  }

  get isUnlocked() {
    return this._data.unlocked && !Enslaved.isRunning;
  }

  get isCharged() {
    return this._data.active;
  }

  get isActive() {
    return this.isCharged && (this.id === 1 || BlackHole(this.id - 1).isActive);
  }

  /**
   * Amount of time the black hole has spent since last state transition,
   * so if it's active, it's the amount of time it's been active for, and if it's inactive,
   * it's the amount of time it's been inactive for.
   */
  get phase() {
    return this._data.phase;
  }

  get cycleLength() {
    return this.interval + this.duration;
  }

  updatePhase(activePeriod) {
    // Prevents a flickering black hole if phase gets set too high
    // (shouldn't ever happen in practice). Also, more importantly,
    // should work even if activePeriods[i] is very large. To check:
    // This used to always use the period of blackHole[0], now it doesn't,
    // will this cause other bugs?
    this._data.phase += activePeriod;
    if (this.phase >= this.cycleLength) {
      // One activation for each full cycle.
      this._data.activations += Math.floor(this.phase / this.cycleLength);
      this._data.phase %= this.cycleLength;
    }
    if (this.isCharged) {
      if (this.phase >= this.duration) {
        this._data.phase -= this.duration;
        this._data.active = false;
        if (GameUI.notify.showBlackHoles) {
          GameUI.notify.blackHole(`Black hole ${this.id} duration ended.`);
        }
      }
    } else if (this.phase >= this.interval) {
      this._data.phase -= this.interval;
      this._data.activations++;
      this._data.active = true;
      if (GameUI.notify.showBlackHoles) {
        GameUI.notify.blackHole(`Black hole ${this.id} is active!`);
      }
    }
  }

  /**
   * Given the time for which the previous black hole is active,
   * this function returns the time for which current black hole is active.
   * For example, for BlackHole(2), this function, given
   * the time for which for BlackHole(1) is active, will return the time for which
   * BlackHole(2) is active during that time.
   */
  realTimeWhileActive(time) {
    const nextDeactivation = this.timeUntilNextDeactivation;
    const cooldown = this.interval;
    const duration = this.duration;
    const fullCycle = this.cycleLength;
    const currentActivationDuration = Math.min(nextDeactivation, duration);
    const activeCyclesUntilLastDeactivation = Math.floor((time - nextDeactivation) / fullCycle);
    const activeTimeUntilLastDeactivation = duration * activeCyclesUntilLastDeactivation;
    const timeLeftAfterLastDeactivation = (time - nextDeactivation + fullCycle) % fullCycle;
    const lastActivationDuration = Math.max(timeLeftAfterLastDeactivation - cooldown, 0);
    return currentActivationDuration + activeTimeUntilLastDeactivation + lastActivationDuration;
  }

  /**
   * Returns the time that the previous black hole must be active until the next change
   * from the active state to the inactive state. For example, for BlackHole(2),
   * this function will return the time BlackHole(1) must be active for BlackHole(2)
   * to transition to the inactive state. This is useful since BlackHole(2)'s phase
   * only increases (that is, its state only changes) while BlackHole(1) is active.
   * In general, a black hole only changes state while the previous black hole is active.
   * So figuring out how long a black hole would be active after some amount of real time
   * (as we do) is best done iteratively via figuring out how long a black hole would be active
   * after a given amount of time of the previous black hole being active.
   */
  get timeUntilNextDeactivation() {
    if (this.isCharged) {
      return this.duration - this.phase;
    }
    return this.cycleLength - this.phase;
  }
}

BlackHoleState.list = Array.range(0, 3).map(id => new BlackHoleState(id));

/**
 * @param {number} id
 * @return {BlackHoleState}
 */
function BlackHole(id) {
  return BlackHoleState.list[id - 1];
}

const BlackHoles = {
  /**
   * @return {BlackHoleState[]}
   */
  get list() {
    return BlackHoleState.list;
  },

  get canBeUnlocked() {
    return player.reality.realityMachines.gte(50) && !this.areUnlocked;
  },

  get areUnlocked() {
    return BlackHole(1).isUnlocked;
  },

  unlock() {
    if (!this.canBeUnlocked) return;
    player.blackHole[0].unlocked = true;
    player.reality.realityMachines = player.reality.realityMachines.minus(50);
    Achievement(144).unlock();
  },

  togglePause: () => {
    if (!BlackHoles.areUnlocked) return;
    player.blackHolePause = !player.blackHolePause;
    GameUI.notify.blackHole(player.blackHolePause ? "Black Hole paused" : "Black Hole unpaused");
  },

  get arePaused() {
    return player.blackHolePause;
  },

  updatePhases(blackHoleDiff) {
    if (!this.areUnlocked || this.arePaused) return;
    // This code is intended to successfully update the black hole phases
    // even for very large values of blackHoleDiff.
    const seconds = blackHoleDiff / 1000;
    const activePeriods = this.realTimePeriodsWithBlackHoleActive(seconds);
    for (const blackHole of this.list) {
      if (!blackHole.isUnlocked) break;
      blackHole.updatePhase(activePeriods[blackHole.id - 1]);
    }
  },

  /**
   * This function takes the total real time spent offline,
   * a number of ticks to simulate, a tolerance for how far ticks can be
   * from average (explained later), and returns a single realTickTime and
   * blackHoleSpeed representing the real time taken up by the first simulated tick
   * and the game speed due to black holess during it.
   *
   * This code makes sure that the following conditions are satisfied:
   * 1: realTickTime * blackHoleSpeed is exactly (up to some small
   * multiple of floating-point precision) the game time which would be spent
   * after realTickTime real time, accounting for black holess
   * (but not for anything else).
   * 2: No tick contains too much (more than a constant multiple of
   * the mean game time per tick) of the game time.
   * 3: No tick has negative or zero real time or (equivalently)
   * negative or zero game time.
   * Note that Patashu has convinced me that we do not want the property
   * "No tick contains too much (more than a constant multiple of the
   * mean real time per tick) of the real time." There's no reason to have it
   * aside from the edge cases of EC12 (and if you're going offline during EC12
   * then you should expect technically correct but somewhat annoying behavior)
   * and auto EC completion (but auto EC completion shouldn't be that much
   * of an issue).
   */
  calculateOfflineTick(totalRealTime, numberOfTicks, tolerance) {
    // Cache speedups, so calculateGameTimeFromRealTime doesn't recalculate them every time.
    const speedups = this.calculateSpeedups();
    const totalGameTime = this.calculateGameTimeFromRealTime(totalRealTime, speedups);
    // We have this special case just in case some floating-point mess prevents
    // binarySearch from working in the numberOfTicks = 1 case.
    // I doubt that's possible but it seems worth handling just in case.
    if (numberOfTicks === 1) {
      return [totalRealTime, totalGameTime / totalRealTime];
    }
    // We want calculateGameTimeFromRealTime(realTickTime, speedups) * numberOfTicks / totalGameTime to be roughly 1
    // (that is, the tick taking realTickTime real time has roughly average length in terms of game time).
    // We use binary search because it has somewhat better worst-case behavior than linear interpolation search here.
    // Suppose you have 3000 seconds without a black hole and then 100 seconds of a black hole with 3000x power,
    // and you want to find when 4000 seconds of game time have elapsed. With binary search it will take only
    // 20 steps or so to get reasonable accuracy, but with linear interpolation it will take about 100 steps.
    // These extra steps might always average out with cases where linear interpolation is quicker though.
    const realTickTime = this.binarySearch(
      0,
      totalRealTime,
      x => this.calculateGameTimeFromRealTime(x, speedups) * numberOfTicks / totalGameTime,
      1,
      tolerance
    );
    const blackHoleSpeedup = this.calculateGameTimeFromRealTime(realTickTime, speedups) / realTickTime;
    return [realTickTime, blackHoleSpeedup];
  },

  /**
   * Standard implementation of binary search for a monotone increasing function.
   * The only unusual thing is tolerance, which is a bound on
   * Math.abs(evaluationFunction(result) - target).
   */
  binarySearch(start, end, evaluationFunction, target, tolerance) {
    while (true) {
      const median = (start + end) / 2;
      const error = evaluationFunction(median) - target;
      if (Math.abs(error) < tolerance) {
        return median;
      }
      if (error < 0) {
        start = median;
      } else {
        end = median;
      }
    }
  },

  /**
   * Returns a list of length (number of unlocked black holes + 1),
   * where each element is the *total* speedup while that black hole
   * is the highest-numbered black hole active, the black holes being numbered
   * starting from black hole 1 and black hole 0 being normal game.
   */
  calculateSpeedups() {
    const effectsToConsider = [GameSpeedEffect.EC12, GameSpeedEffect.TIMEGLYPH, GameSpeedEffect.BLACKHOLE];
    const speedupWithoutBlackHole = getGameSpeedupFactor(effectsToConsider, 1);
    const speedups = [1];
    for (const blackHole of this.list) {
      if (!blackHole.isUnlocked) break;
      const speedupFactor = getGameSpeedupFactor(effectsToConsider, undefined, blackHole.id);
      speedups.push(speedupFactor / speedupWithoutBlackHole);
    }
    return speedups;
  },

  calculateGameTimeFromRealTime(realTime, speedups) {
    const effectivePeriods = this.realTimePeriodsWithBlackHoleEffective(realTime, speedups);
    return effectivePeriods
      .map((period, i) => period * speedups[i])
      .sum();
  },

  /**
   * Returns the amount of real time spent with each unlocked black hole
   * being the current "effective" black hole, that is, the active black hole
   * with the highest index.
   * For example:
   * active periods = [100, 20, 5] (100ms of real time, 20ms of black hole 1, 5ms of black hole 2)
   * effective periods = [80, 15, 5]
   * 80ms of effective real time, because black hole 1 will be running in total 20ms => 100 - 20
   * 15ms of effective black hole 1 time, because black hole 2 will be running in total 5ms => 20 - 5
   * 5ms of effective black hole 2 time, because no higher black hole overlaps it,
   * so it is effective for the whole active period
   * Note: even though more than one black hole can be active
   * (and thus effective) at once, the calling function first calculates the total speedups
   * while each black hole is the highest-index black hole that's active and then acts
   * as if only the highest-index black hole that's active is effective.
   */
  realTimePeriodsWithBlackHoleEffective(realTime) {
    const activePeriods = this.realTimePeriodsWithBlackHoleActive(realTime);
    const effectivePeriods = [];
    for (let i = 0; i < activePeriods.length - 1; i++) {
      effectivePeriods.push(activePeriods[i] - activePeriods[i + 1]);
    }
    effectivePeriods.push(activePeriods.last());
    return effectivePeriods;
  },

  /**
   * Returns an array of real time periods spent in each black hole
   * with first element being the "no black hole" state that is normal game.
   */
  realTimePeriodsWithBlackHoleActive(realTime) {
    const activePeriods = [realTime];
    for (const blackHole of this.list) {
      if (!blackHole.isUnlocked) break;
      const activeTime = blackHole.realTimeWhileActive(activePeriods.last());
      activePeriods.push(activeTime);
    }
    return activePeriods;
  }
};
