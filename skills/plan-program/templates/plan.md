# {Program name}

<!--
  The plan a developer reads before saying yes. The contract beside it
  (contract.json) holds every structured fact: success criteria, each strand's
  scope, acceptance and dependsOn, each prerequisite's runbook and
  verifyCommand, each decision's answer. This document carries what the
  contract cannot — why, how, and what was considered — and refers to the rest
  by id. One home per fact.

  There is nowhere here to list jobs, on purpose. How a strand is cut into jobs
  is decided at run time by its orchestrator, with the code in front of it.

  Delete these comments as you fill the sections in.
-->

## Overview

<!-- What this program delivers, in a paragraph a developer could repeat. Then what
     it deliberately does not deliver (the contract's `outOfScope`, in prose). -->

## Who it is for

<!-- The stories themselves (who, what is wrong today, what changes, the human's
     own words) live in the contract, by id. Say here what the contract cannot:
     how the stories relate, which matters most and why, and what the human said
     that shaped them. Refer to each by id (US-01); do not restate one. -->

## Architecture

<!-- What changes from the system as built: new modules, moved boundaries, changed
     data shapes, new dependencies. What stays exactly as it is. -->

## Strands

<!-- One section per strand. The heading MUST begin with the strand's id, exactly
     as in the contract: that is how the section is found, checked, and handed
     word for word to the strand's orchestrator. As few strands as the work
     honestly has; one is fine. -->

### S-01 {Strand name}

<!-- What will exist afterwards, in terms a developer can picture. -->

#### Approach

<!-- Medium fidelity: the modules touched, the shapes of the interfaces and data
     that cross a boundary, how it is tested. Enough to say "yes, that" or "no, not
     like that", and no more. The strand's orchestrator may depart from the HOW when
     the code demands it, and must record that it did; the WHAT and the scope hold. -->

#### Considered and rejected

<!-- The alternatives weighed, and why not. This is what stops the strand's
     orchestrator rediscovering them at 3 a.m. -->

## Decisions

<!-- Each choice that could be seen coming and is expensive to reverse, or that the
     human simply wants to make. By id, as in the contract: the question, the
     options, the leaning and why. The answer itself lives in the contract.
     A decision the run could happily make does not belong here. -->

### D-01 {The question}

## Human prerequisites

<!-- Only if the actor audit found any; delete this section otherwise. Each HP by
     id: what it unblocks, and why the crew cannot do it (cannot, not tedious). The
     runbook and the verifyCommand live in the contract.

     Say which kind each is: needed before a strand can START, or needed only for a
     verification step to RUN. The second kind does not stop the night: the step
     is deferred and the work carries on a provisional line until you are back. -->

### HP-01 {What is true once it is done}

## Program boundary

<!-- Only if this program was split: which OUTPUT OF THE RUN the human's next step
     depends on, and what the next program is. If no human step depends on the
     run's own output, hoist the step to a prerequisite, keep the program whole,
     and delete this section. -->

## Risks

<!-- What could make this plan wrong, and what would tell you early. -->
