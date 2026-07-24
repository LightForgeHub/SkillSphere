import { gql } from "graphql-tag";

export const typeDefs = gql`
  type User {
    id: ID!
    walletAddress: String!
    createdAt: String!
    expert: Expert
  }

  type Expert {
    id: ID!
    userId: String!
    name: String!
    bio: String!
    skills: [String!]!
    hourlyRate: Float!
    isAvailable: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type ExpertsPage {
    experts: [Expert!]!
    total: Int!
    page: Int!
    pageSize: Int!
    totalPages: Int!
  }

  type UpdateProfileResult {
    success: Boolean!
    expert: Expert
    error: String
  }

  type Query {
    """
    Returns a paginated list of experts, optionally filtered by skill.
    """
    experts(page: Int, pageSize: Int, skill: String): ExpertsPage!

    """
    Returns a single expert by their wallet address.
    """
    expertByWallet(walletAddress: String!): Expert
  }

  type Mutation {
    """
    Update an expert's profile. Requires valid wallet signature in headers.
    """
    updateProfile(
      name: String
      bio: String
      skills: [String!]
      hourlyRate: Float
      isAvailable: Boolean
    ): UpdateProfileResult!

    """
    Register as an expert. Requires valid wallet signature in headers.
    """
    registerExpert(name: String!, bio: String, skills: [String!], hourlyRate: Float): UpdateProfileResult!
  }
`;
