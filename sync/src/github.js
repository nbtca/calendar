import { readProjectItem } from "./plan.js";

const ITEMS_QUERY = `
  query($login: String!, $number: Int!, $cursor: String) {
    organization(login: $login) {
      projectV2(number: $number) {
        items(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            updatedAt
            content {
              __typename
              ... on Issue {
                title
                url
                number
                repository { nameWithOwner }
              }
              ... on DraftIssue { title }
              ... on PullRequest {
                title
                url
                number
                repository { nameWithOwner }
              }
            }
            fieldValues(first: 40) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 200) } };
  }
}

export async function listProjectItems(fetchImpl, env, owner, number) {
  const items = [];
  let cursor = null;
  do {
    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "nbtca-calendar",
      },
      body: JSON.stringify({
        query: ITEMS_QUERY,
        variables: { login: owner, number, cursor },
      }),
    });
    const payload = await readJson(response);
    if (!response.ok || payload.errors) {
      const message =
        payload.errors?.map((error) => error.message).join("; ") ||
        payload.message ||
        response.status;
      throw new Error(`GitHub project query failed: ${message}`);
    }
    const project = payload.data?.organization?.projectV2;
    if (!project) throw new Error(`GitHub project ${owner}/${number} was not found`);
    for (const node of project.items.nodes) {
      const item = readProjectItem(node);
      if (item) items.push(item);
    }
    cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}
