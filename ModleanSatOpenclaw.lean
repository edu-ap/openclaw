/-
  ModleanSatOpenclaw — satellite for openclaw.
-/
import Modlean.Domain.Dev
import Modlean.Subject

namespace ModleanSatOpenclaw

open Modlean
open Modlean.Dev
open Modlean.Subject

def proj : DevProject :=
  { project :=
      { slug := "openclaw"
      , title := "openclaw"
      , category := .dev
      , status := .active
      , owner := eduPid
      , source := .github "edu-ap/openclaw" "HEAD"
      }
  , repo? := some "edu-ap/openclaw"
  , purpose := "Open-source compliance/legal automation framework."
  }

end ModleanSatOpenclaw
