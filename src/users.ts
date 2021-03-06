// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as Octokit from '@octokit/rest';
import {Member, Team} from './types';
import {octo, users} from './util';

/**
 * Ensure all provided teams actually exist in all orgs.
 * Create them if they don't.  Return a list of teams with Ids.
 */
export async function reconcileTeams() {
  // obtain all of the teams across all supported orgs
  const teamMap = new Map<string, Team[]>();
  const yoshiTeams = new Array<Team>();
  const promises = users.orgs.map(async org => {
    const teams = new Array<Team>();
    let page = 1;
    let res: Octokit.AnyResponse;
    console.log(`Fetching teams for ${org}...`);
    do {
      res = await octo.teams.list({org, per_page: 100, page});
      res.data.forEach((t: Team) => {
        t.org = org;
        teams.push(t);
      });
      page++;
    } while (res && res.headers && res.headers.link &&
             res.headers.link.indexOf('rel="last"') > -1);
    console.log(`Found ${teams.length} teams in ${org}.`);
    teamMap.set(org, teams);
  });
  await Promise.all(promises);

  // Loop over the desired teams for each org. Create any missing ones.
  users.membership.forEach(m => {
    users.orgs.forEach(async org => {
      const orgTeams = teamMap.get(org)!;
      const match =
          orgTeams.find(x => x.name.toLowerCase() === m.team.toLowerCase())!;
      if (!match) {
        throw new Error(`Team '${m.team}' does not exist in ${org}.`);
      }
      yoshiTeams.push(match);
    });
  });

  return yoshiTeams;
}

export async function reconcileRepos() {
  const promises = new Array<Promise<Octokit.AnyResponse|void>>();
  const teams = await reconcileTeams();

  users.membership.forEach(m => {
    m.repos.forEach(async r => {
      const [o, repo] = r.split('/');
      const team = getTeam(m.team, o, teams);
      const yoshiAdmins = getTeam('yoshi-admins', o, teams);
      const yoshiTeam = getTeam('yoshi', o, teams);

      if (!team) {
        throw new Error(`Unable to find team '${m.team}`);
      }

      // Add the language specific team
      await (octo.teams
                 .addOrUpdateRepo(
                     {team_id: team.id, owner: o, permission: 'push', repo})
                 .catch(e => {
                   console.error(`Error adding ${r} to ${m.team}.`);
                 }));

      // Add the yoshi admins team
      await (octo.teams
                 .addOrUpdateRepo({
                   team_id: yoshiAdmins!.id,
                   owner: o,
                   permission: 'admin',
                   repo
                 })
                 .catch(e => {
                   console.error(`Error adding ${r} to 'yoshi-admins'.`);
                   console.error(e);
                 }));

      // Add the yoshi team
      await (
          octo.teams
              .addOrUpdateRepo(
                  {team_id: yoshiTeam!.id, owner: o, permission: 'pull', repo})
              .catch(e => {
                console.error(`Error adding ${r} to 'yoshi'.`);
              }));
    });
  });
  // await Promise.all(promises);
}

function getTeam(team: string, org: string, teams: Team[]) {
  return teams.find(x => {
    return x.name.toLowerCase() === team.toLowerCase() &&
        x.org!.toLowerCase() === org.toLowerCase();
  });
}

export async function reconcileUsers() {
  const promises = new Array<Promise<Octokit.AnyResponse|void>>();
  const teams = await reconcileTeams();
  for (const o of users.orgs) {
    for (const m of users.membership) {
      const team = getTeam(m.team, o, teams);
      if (!team) {
        throw new Error(`Unable to find team '${m.team}`);
      }

      // get the current list of team members
      const res =
          await octo.teams.listMembers({team_id: team.id, per_page: 100});
      const currentMembers = res.data as Member[];

      // add any missing users
      for (const u of m.users) {
        const match =
            currentMembers.find(x => x.login.toLowerCase() === u.toLowerCase());
        if (!match) {
          console.log(`Adding ${u} to ${o}/${team.name}...`);
          const p =
              octo.teams.addMember({team_id: team.id, username: u}).catch(e => {
                console.error(`Error adding ${u} to ${team.org}/${team.name}.`);
                console.error(e.message);
              });
          promises.push(p);
        }
      }

      // remove any bonus users
      for (const u of currentMembers) {
        const match =
            m.users.find(x => x.toLowerCase() === u.login.toLowerCase());
        if (!match) {
          console.log(`Removing ${u.login} from ${team.name}...`);
          const p =
              octo.teams.removeMember({team_id: team.id, username: u.login})
                  .catch(e => {
                    console.error(
                        `Error removing ${u.login} from ${team.name}.`);
                    // console.error(e);
                  });
          promises.push(p);
        }
      }
    }
  }
  await Promise.all(promises);
}
