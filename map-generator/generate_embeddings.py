import pandas as pd
from transformers import AutoTokenizer, AutoModel
import torch
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity
import umap
import plotly.express as px

df = pd.read_csv("../data/combined_researcher_papers.csv")
df['text_to_embed'] = df['paper_title'] + df['paper_abstract'] + df["ai_generated_keywords"] + df["researcher_keywords"]
modifiedDf = df.copy()

tokenizer = AutoTokenizer.from_pretrained("thenlper/gte-small")
model = AutoModel.from_pretrained("thenlper/gte-small")
# print(model.parameters())

tokenLengths = []

def getEmbedding(text):

    inputs = tokenizer(text, return_tensors='pt', padding=True, truncation=True, max_length=512)
    tokenLengths.append(len(inputs['input_ids'][0]))

    with torch.no_grad():
        outputs = model(**inputs)

    embeddings = outputs.last_hidden_state.mean(dim=1)
    embeddings = embeddings.squeeze()
    embeddingsNumpy = embeddings.numpy()
    
    return embeddingsNumpy

modifiedDf['text_to_embed'] = modifiedDf['text_to_embed'].astype(str) # since some entries have unicode chars, nums, etc.

embeddings = []
for text in modifiedDf['text_to_embed'].tolist():
    embedding = getEmbedding(text)
    embeddings.append(embedding)

modifiedDf['embedding'] = embeddings

def median_embedding(x):
    return np.median(np.vstack(x), axis=0)

def first_value(x):
    return x.iloc[0]

# Define columns to keep in final output
output_columns = ['researcher_name', 'profile_url', 'google_scholar_id', 'affiliation',
                 'researcher_total_citations', 'researcher_keywords', 'researcher_homepage',
                 'paper_abstract', 'ai_generated_keywords', 'ai_generated_summary']

# Create aggregation dictionary for specified columns
agg_dict = {'embedding': median_embedding}
for col in output_columns:
    if col != 'researcher_name':  # researcher_name is the groupby column
        agg_dict[col] = first_value

# use median_embedding for embeddings and first_value for other columns when aggregating
modifiedDf = modifiedDf.groupby('researcher_name').agg(agg_dict).reset_index()

# no changes to UMAP and further visualization
avgEmbeddingsMatrix = np.vstack(modifiedDf['embedding'].values)

seed = 42
reducer = umap.UMAP(n_neighbors=5, min_dist=0.15, n_components=2, random_state=42)
avgEmbeddings2D = reducer.fit_transform(avgEmbeddingsMatrix)

print("Avg token length:", np.mean(tokenLengths))
print("Max token length:", np.max(tokenLengths))

modifiedDf['x'] = avgEmbeddings2D[:, 0]
modifiedDf['y'] = avgEmbeddings2D[:, 1]

fig = px.scatter(modifiedDf, x='x', y='y', color='researcher_name', hover_data={'researcher_name': True, 'ai_generated_keywords': True},
                 title='Researcher embeddings - median of paper embeddings', labels={'x': 'x-axis', 'y': 'y-axis'})
fig.show()

fig.write_html("people_embeddings_median_visualization.html")

# convert embeddings to string format
modifiedDf['embedding_array'] = modifiedDf['embedding'].apply(lambda x: str(x.tolist()))

# extract 2d points (x,y) and all specified columns to a csv file
final_columns = output_columns + ['x', 'y', 'embedding_array']
modifiedDf[final_columns].to_csv("embeddings.csv", index=False)