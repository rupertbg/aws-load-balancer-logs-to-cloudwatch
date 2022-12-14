FROM public.ecr.aws/lambda/nodejs:16

COPY ./package* ./
RUN npm install

COPY index.js ${LAMBDA_TASK_ROOT}

CMD [ "app.handler" ]
