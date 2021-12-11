import { TimeStudy } from "./normal-time-study";

/**
 * Abstract representation of a full time study tree object. The intended usage is to supply the constructor with
 * an import string and a budget of time/space theorems, which it will use together to determine which studies can
 * actually be purchased in the specified order. All of the complex purchasing logic should be handled here, and not
 * in any TimeStudyState objects. During parsing, some minor additional info is stored in order to improve user
 * feedback when attempting to import other study trees.
 * 
 * Usage notes:
 * - Unless commitToGameState() is called, this only ever creates a "virtual" tree object which does not change the
 *   overall game state. This class serves the purpose of having all the purchasing and locking logic in one place.
 *   Only upon calling commitToGameState() will the game actually try to get every study specified in tree.
 * - The general intent is that the logic in this class is meant to pull minimally from the extrenal game state; for
 *   example, how many dimension paths are allowed or which ECs are unlockable depend on only the data in the tree
 *   object itself and should not depend on the actual current game state
 * - All study entries must be Strings because numbers (normal TS) and EC# (ECs) need to be supported
 * 
 * @member {Boolean} checkCosts          Boolean denoting whether or not costs of studies should be checked or not
 *  when attempting to buy studies; if true, uses current total theorem counts to determine affordability
 * @member {Number[]} spentTheorems      Two-element array containing TT/ST totals for studies which were actually
 *  purchased after accounting for various conditions which would forbid some being bought (eg. cost or tree structure)
 * @member {String[]} invalidStudies     Array of studies from the initial string which are correctly formatted
 *  but don't actually exist; used for informational purposes elsewhere
 * @member {TimeStudyState[]} purchasedStudies   Array of studies which were actually purchased, using the given amount
 *  of available theorems
 * @static {TimeStudyTree} currentTree   A designated TimeStudyTree object which is initialized to the current state
 *  of the time study tree in the game and then continually updated to be kept in a consistent state
 */
export class TimeStudyTree {
  // The first parameter will either be an import string or an array of studies (possibly with an EC at the end)
  constructor(studies, checkCosts) {
    this.checkCosts = checkCosts;
    this.spentTheorems = [0, 0];
    this.invalidStudies = [];
    this.purchasedStudies = [];
    switch (typeof studies) {
      case "string":
        // Input parameter is an unparsed study import string
        if (TimeStudyTree.isValidImportString(studies)) {
          this.attemptBuyArray(this.parseStudyImport(studies));
        }
        break;
      case "object":
        // Input parameter is an array of Strings assumed to be already formatted as expected in the parsing method.
        // This allows code for combining trees to look simpler and more readable
        this.attemptBuyArray([...studies]);
        break;
    }
  }

  // Note that this only checks pure formatting, not whether or not a study/EC actually exists, but verifying correct
  // formatting separately from verifying existence allows us to produce more useful in-game error messages for
  // import strings which are formatted correctly but aren't entirely valid
  static isValidImportString(input) {
    return /^(\d+)(,(\d+))*(\|\d+)?$/u.test(input);
  }

  // Getter for all the studies in the current game state
  static get currentStudies() {
    const currentStudies = player.timestudy.studies.map(s => TimeStudy(s));
    if (player.challenge.eternity.unlocked !== 0) {
      currentStudies.push(TimeStudy.eternityChallenge(player.challenge.eternity.unlocked));
    }
    return currentStudies;
  }

  // The existence of this is mildly hacky, but basically we need to initialize currentTree to the study tree's state
  // from the game state on load. This is called within the on-load code because it piggybacks on a lot of existing
  // logic (to avoid tons of boilerplate) which itself relies on many parts of the code which haven't been properly
  // loaded in yet at the time of this class being loaded in
  static initializeCurrentTree() {
    const onLoadStudies = this.currentStudies;
    this.currentTree = new TimeStudyTree(onLoadStudies, false);
  }

  // THIS METHOD HAS LASTING CONSEQUENCES ON THE GAME STATE. STUDIES WILL ACTUALLY BE PURCHASED IF POSSIBLE.
  // Attempts to buy the specified study; if null, assumed to be a study respec and clears state instead
  static addStudyToGameState(study) {
    if (study) {
      this.currentTree.attemptBuyArray([study]);
      this.currentTree.commitToGameState();
    } else {
      this.currentTree = new TimeStudyTree([], true);
    }
  }

  // THIS METHOD HAS LASTING CONSEQUENCES ON THE GAME STATE. STUDIES WILL ACTUALLY BE PURCHASED IF POSSIBLE.
  // Uses the internal state of this TimeStudyTree to actually try to purchase all the listed studies within
  commitToGameState() {
    for (const study of this.purchasedStudies) {
      if (!study.isBought) study.purchase(true);
    }
  }

  // This reads off all the studies in the import string and splits them into invalid and valid study IDs. We hold on
  // to invalid studies for additional information to present to the player
  parseStudyImport(input) {
    const treeStudies = input.split("|")[0].split(",");
    const studyDB = GameDatabase.eternity.timeStudies.normal.map(s => s.id);
    const studyArray = [];
    for (const study of treeStudies) {
      if (studyDB.includes(parseInt(study, 10))) studyArray.push(TimeStudy(study));
      else this.invalidStudies.push(study);
    }

    // If the string has an EC indicated in it, append that to the end of the study array
    const ecString = input.split("|")[1];
    if (!ecString) {
      // Study strings without an ending "|##" are still valid, but will result in ecString being undefined
      return studyArray;
    }
    const ecID = parseInt(ecString, 10);
    const ecDB = GameDatabase.eternity.timeStudies.ec;
    // Specifically exclude 0 because saved presets will contain it by default
    if (!ecDB.map(c => c.id).includes(ecID) && ecID !== 0) {
      this.invalidStudies.push(`EC${ecID}`);
      return studyArray;
    }
    if (ecID !== 0) studyArray.push(TimeStudy.eternityChallenge(ecID));
    return studyArray;
  }

  // Attempt to purchase all studies specified in the array which may be either study IDs (which get converted) or
  // study objects. The method needs to support both because turning it entirely to studies causes circular references
  // which make the game fail to load
  attemptBuyArray(studyArray) {
    for (const study of studyArray) {
      const toBuy = typeof study === "object" ? study : TimeStudy(study);
      if (this.canBuySingle(toBuy)) this.purchasedStudies.push(toBuy);
    }
  }

  // Tries to buy a single study, accounting for all various requirements and locking behavior in the game. If the
  // requirement is satisfied, then the running theorem costs will be updated (always) and the remaining usable
  // theorems will be decremented (only if there are enough left to actually purchase)
  canBuySingle(study) {
    // Import strings can contain repeated or undefined entries
    if (!study || this.purchasedStudies.includes(study)) return false;

    const check = req => (typeof req === "number"
      ? this.purchasedStudies.includes(TimeStudy(req))
      : req());
    const config = study.config;
    let reqSatisfied;
    switch (config.reqType) {
      case TS_REQUIREMENT_TYPE.AT_LEAST_ONE:
        reqSatisfied = config.requirement.some(r => check(r));
        break;
      case TS_REQUIREMENT_TYPE.ALL:
        reqSatisfied = config.requirement.every(r => check(r));
        break;
      case TS_REQUIREMENT_TYPE.DIMENSION_PATH:
        reqSatisfied = config.requirement.every(r => check(r)) && this.currDimPathCount < this.allowedDimPathCount;
        break;
      default:
        throw Error(`Unrecognized TS requirement type: ${this.reqType}`);
    }
    if (!reqSatisfied) return false;

    const stDiscount = V.has(V_UNLOCKS.RA_UNLOCK) ? 2 : 0;
    const stNeeded = config.STCost && config.requiresST.some(s => this.purchasedStudies.includes(TimeStudy(s)))
      ? Math.clampMin(config.STCost - stDiscount, 0)
      : 0;
    if (this.checkCosts) {
      const maxTT = Currency.timeTheorems.value.add(TimeStudyTree.currentTree.spentTheorems[0])
        .clampMax(Number.MAX_VALUE).toNumber();
      const maxST = V.spaceTheorems;
      if (this.spentTheorems[0] + config.cost > maxTT || this.spentTheorems[1] + stNeeded > maxST) {
        return false;
      }
    }
    this.spentTheorems[0] += config.cost;
    this.spentTheorems[1] += stNeeded;
    return true;
  }

  get currDimPathCount() {
    return [71, 72, 73].countWhere(x => this.purchasedStudies.includes(TimeStudy(x)));
  }

  get allowedDimPathCount() {
    if (DilationUpgrade.timeStudySplit.isBought) return 3;
    if (this.purchasedStudies.includes(TimeStudy(201))) return 2;
    return 1;
  }

  get dimensionPaths() {
    const pathSet = new Set();
    const validPaths = [TIME_STUDY_PATH.ANTIMATTER_DIM, TIME_STUDY_PATH.INFINITY_DIM, TIME_STUDY_PATH.TIME_DIM];
    for (const path of validPaths) {
      const pathEntry = NormalTimeStudies.pathList.find(p => p.path === path);
      for (const study of this.purchasedStudies) {
        if (pathEntry.studies.includes(study.id)) {
          pathSet.add(pathEntry.name);
          break;
        }
      }
    }
    return Array.from(pathSet);
  }

  get pacePaths() {
    const pathSet = new Set();
    const validPaths = [TIME_STUDY_PATH.ACTIVE, TIME_STUDY_PATH.PASSIVE, TIME_STUDY_PATH.IDLE];
    for (const path of validPaths) {
      const pathEntry = NormalTimeStudies.pathList.find(p => p.path === path);
      for (const study of this.purchasedStudies) {
        if (pathEntry.studies.includes(study.id)) {
          pathSet.add(pathEntry.name);
          break;
        }
      }
    }
    return Array.from(pathSet);
  }

  get ec() {
    // This technically takes the very first EC entry if there's more than one, but that shouldn't happen in practice
    const ecStudies = this.purchasedStudies.find(s => s instanceof ECTimeStudyState);
    return ecStudies ? ecStudies.id : 0;
  }

  // Creates an export string based on all currently purchased studies
  get exportString() {
    return `${this.purchasedStudies
      .filter(s => s instanceof NormalTimeStudyState)
      .map(s => s.id)
      .join(",")}|${this.ec}`;
  }
}
