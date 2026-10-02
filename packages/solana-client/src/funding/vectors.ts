// Shared cross-language vectors. The identical table is asserted by the Rust
// unit test `binding_hash_vectors` in the program's state module.
export const BINDING_VECTORS = [
  {
    organizationId: "00000000-0000-0000-0000-000000000001",
    projectId: "00000000-0000-0000-0000-000000000002",
    taskId: "00000000-0000-0000-0000-000000000003",
    budgetAuthorizationId: "00000000-0000-0000-0000-000000000004",
    hashHex: "d97dd77a389263187180844ccbee8d7f6fbe6bfd368450c9f72c299faedb57e8",
  },
  {
    organizationId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    projectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    taskId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    budgetAuthorizationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    hashHex: "124f563831b581f24e12bd60aa36c5dd78d088496a028775aa57e3942ff2937a",
  },
] as const;
