# AiMap

AIMAP is a vis tool that shows the researchers at Georgia Tech's College of Computing and the different research areas they're involved in. You can enter your research interests and view researchers/collaborators/proposals that are the best match for you! To run AIMAP locally, follow the steps below to set up your environment and replicate the dataset.

## Running AiMap locally

### Step 1: Download Precomputed Data and Embeddings

All the precomputed data is stored in hugging face that are needed to run AiMap locally. After cloning the `aimap-private` repository, download the dataset from the  [hugging face repository](https://huggingface.co/datasets/techkid673/aimap-data).

Clone the dataset into the `data` folder:

```sh

mkdir -p data

cd data

git clone https://huggingface.co/datasets/techkid673/aimap-data

cd ..

```

### Step 2: Scraping Georgia Tech Research Data

To replicate the dataset available on Hugging Face, you need to scrape Georgia Tech's College of Computing (CoC) research data, including abstracts and the top 50 cited papers from Google Scholar.

1. Navigate to the `backend-feature/gs-data-scraping` branch.

2. Follow the README documentation in that branch to run the data scraping pipeline.

### Step 3: Generate Researcher Embeddings

Once you have obtained the scraped data, the next step is to generate researcher embeddings.

1. Navigate to the `backend-feature/researcher-embeddings` branch.

2. Follow the README documentation in that branch to generate embeddings using the CSV file containing the scraped data.

### Step 4: Generate Precomputed Keywords and Summaries

Using the LLaMA or Phi-3 llm, extract keywords from each abstract and generate a summary of each researcher's work.

1. Navigate to the `backend-feature/llm-pipeline` branch.

2. Follow the README documentation in that branch to process and the dataset to extract keywords and summaries from the CSV file containing the scraped data.